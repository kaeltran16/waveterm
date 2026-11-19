// The brainstorm and canvas cards in the Rendered transcript: RBS_KIT, the helpers the scenarios-rendered-bs-*.mjs
// modules are handed, their aggregate RENDERED_BS_SCENARIOS, and this module's own scenario, rendered-bs-host.
//
// A scenario's agent is a fixture roster agent (no controller, so nothing runs in its terminal) with a claude
// transcript and a brainstorm.json under a temp project; the roster's brainstormFile attaches it as the tab meta
// would. The file is the agent's side of the protocol: a step rewrites it and waits for the poller to draw it. A
// line the page sends the agent (agentprompt, and a judge stop) is recorded and answered in the page, since no agent
// reads it; the cards then read the line as sent, as they would against a live agent.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import boards from "./scenarios-rendered-bs-boards.mjs";
import check from "./scenarios-rendered-bs-check.mjs";
import composer from "./scenarios-rendered-bs-composer.mjs";
import design from "./scenarios-rendered-bs-design.mjs";
import mockup from "./scenarios-rendered-bs-mockup.mjs";
import question from "./scenarios-rendered-bs-question.mjs";
import review from "./scenarios-rendered-bs-review.mjs";
import rows from "./scenarios-rendered-bs-rows.mjs";
import run from "./scenarios-rendered-bs-run.mjs";
import {
    BS_HISTORY,
    BS_POLL_WAIT_MS,
    BS_Q4,
    bsFile,
    bsParts,
    polishNap,
    polishWaitFor,
    skipStep,
} from "./scenarios-shared.mjs";

const MODEL_ID = "claude-opus-5-5";
const WAIT_MS = 10_000;
// the column measure a narrowed step sets: under the cards' COMPACT_CARD_PX (600)
const NARROW_PX = 560;
const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const COLUMN = `${RV}?.querySelector("[data-rendered-column]")`;
const HOST = `${RV}?.querySelector("[data-rendered-brainstorm]")`;
// the brainstorm pane in Rendered is the workspace pane's Brainstorm tab, beside the transcript
const PANE = `document.querySelector('aside[aria-label="Workspace"] [data-brainstorm-pane]')`;
const FLAT = `const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();`;

const rosterAgent = (id, blockId, name, transcriptPath, brainstormFile) => ({
    id,
    name,
    project: name,
    task: "rendered brainstorm fixture",
    state: "idle",
    agent: "claude",
    model: MODEL_ID,
    blockId,
    transcriptPath,
    brainstormFile,
});

// the canvas.json a board list makes, each board 1440 wide, in the order given
function writeCanvas(cwd, canvas, names) {
    const project = join(cwd, ".superpowers", "design", canvas, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
        join(project, "canvas.json"),
        JSON.stringify({ boards: Object.fromEntries(names.map((b) => [b, { w: 1440, h: 900 }])), order: names })
    );
    for (const b of names) writeBoard(cwd, canvas, b);
    return project;
}

function writeBoard(cwd, canvas, name, body = name) {
    writeFileSync(
        join(cwd, ".superpowers", "design", canvas, "project", name),
        `<!doctype html><title>${name}</title><h1 style="font:64px sans-serif">${body}</h1>`
    );
}

function writeFile(ctx, file) {
    writeFileSync(ctx.file, typeof file === "string" ? file : JSON.stringify(file, null, 2));
}

// opts: topic, file (the first brainstorm.json, an object or raw text), transcript (record lines; a prompt and a reply
// by default), boards (canvas board names: writes the brainstorm's canvas project), noBrainstorm (an agent with only
// the canvas), noTab (auto-open's Brainstorm tab turned down, so the full card draws: while the tab shows, the card is
// one row). A throw past the temp dir still returns ctx, so teardown removes whatever was made
async function arrange(h, name, opts = {}) {
    const tag = Date.now().toString(36);
    const topic = opts.topic ?? `rbs-${tag}`;
    const ctx = { name, topic, tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-rendered-bs-")) };
    ctx.cwd = join(ctx.dir, "project");
    ctx.file = join(ctx.cwd, ".superpowers", "brainstorm", topic, "brainstorm.json");
    try {
        mkdirSync(dirname(ctx.file), { recursive: true });
        if (!opts.noBrainstorm) writeFile(ctx, opts.file ?? bsFile({ canvas: topic }));
        if (opts.boards) ctx.project = writeCanvas(ctx.cwd, opts.canvas ?? topic, opts.boards);
        const transcript = writeTranscript(
            ctx.dir,
            `rbs-${tag}`,
            opts.transcript ?? [userText("Let's think the lag alerts through before building."), assistantText("I'll ask as we go.")]
        );
        // a step that needs a later turn appends to it
        ctx.transcript = transcript;
        await h.goto("agent");
        const t = await makeTab(h, ctx, { label: `rbs-${tag}`, blockMeta: { view: "term", controller: null } });
        Object.assign(ctx, { agentId: t.tabId, blockId: t.blockId });
        if (opts.noTab) await turnDownTab(h, ctx);
        await setRoster(h, [rosterAgent(t.tabId, t.blockId, `rbs-${tag}`, transcript, opts.noBrainstorm ? undefined : ctx.file)]);
        await focusAgent(h, ctx.agentId);
        ctx.rendered = await showRendered(h);
        if (!ctx.rendered) throw new Error("the Rendered view never showed for the fixture agent");
        if (!(await polishWaitFor(h, `!!${HOST}?.hasAttribute("data-rendered-bs-card")`, WAIT_MS))) {
            throw new Error("the brainstorm host never drew under the timeline");
        }
        // the poller attaches the roster's brainstorm and reads its file on its own tick
        if (!opts.noBrainstorm && !(await brainstormRead(h, ctx))) {
            throw new Error("the poller never read the fixture's brainstorm.json");
        }
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

// dismisses the first Brainstorm tab auto-open brings, as its x does, which turns auto-open's brainstorm down for the
// agent; on the next tick, since auto-open records the tab it opened only after it opened it, and dismissing counts only
// a tab it recorded. A tab a step opens after that stays
const turnDownTab = (h, ctx) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const A = await mod("app/view/agents/autoopen.ts");
        const id = ${JSON.stringify(ctx.agentId)};
        const ws = W.workspaceAtom(id);
        window.__rbsNoTab ??= {};
        const off = globalStore.sub(ws, () => {
            if (!globalStore.get(ws).tabs.some((t) => t.kind === "brainstorm")) return;
            off();
            delete window.__rbsNoTab[id];
            setTimeout(() => A.dismissWorkspaceTab(id, { kind: "brainstorm" }), 0);
        });
        window.__rbsNoTab[id] = off;
        return true;`
    );

const brainstormRead = (h, ctx) =>
    agentPage(
        h,
        `const S = await mod("app/view/agents/brainstormstore.ts");
        return until(() => S.getBrainstorm(${JSON.stringify(ctx.agentId)})?.file != null, ${BS_POLL_WAIT_MS});`
    );

// the agent's center in Rendered, and its brainstorm (if any) on the Rendered side of the header's switch
async function showRendered(h) {
    await h.ev(`(() => {
        const b = ${SURF}?.querySelector("button[data-view-toggle]");
        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        return true;
    })()`);
    return polishWaitFor(h, `${RV} != null`, WAIT_MS);
}

// the Brainstorm and Canvas tabs closed, as their x does, so the transcript has the row to itself again
const closePaneTabs = (h, ctx) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        for (const key of ["brainstorm", "canvas"]) W.closeWorkspaceTab(${JSON.stringify(ctx.agentId)}, key);
        return true;`
    ).then(() =>
        polishWaitFor(h, `${RV} != null && !document.querySelector('aside[aria-label="Workspace"]')`, WAIT_MS)
    );

// the host as drawn: the card kind it shows, whether it is compact, its flat text, and where it sits
const readHost = (h) =>
    h.ev(`(() => {
        ${FLAT}
        const host = ${HOST};
        const feed = ${RV}?.querySelector("[data-rendered-feed]");
        const col = ${COLUMN};
        return {
            host: host != null,
            kind: host?.getAttribute("data-rendered-bs-card") ?? null,
            compact: host?.hasAttribute("data-compact") ?? null,
            width: host ? Math.round(host.getBoundingClientRect().width) : null,
            text: flat(host),
            lastInColumn: host != null && col?.lastElementChild === host,
            belowFeed: host != null && feed != null && host.getBoundingClientRect().top >= feed.getBoundingClientRect().bottom - 1,
            feed: flat(feed),
        };
    })()`);

// the host's kind turns "none" at once while the leaving card is still in the DOM through its exit fade,
// so no card waits for that card to go too
const waitCard = (h, kind, ms = BS_POLL_WAIT_MS) =>
    polishWaitFor(
        h,
        kind === "none"
            ? `(() => { ${FLAT} const host = ${HOST}; return host?.getAttribute("data-rendered-bs-card") === "none" && flat(host) === ""; })()`
            : `${HOST}?.getAttribute("data-rendered-bs-card") === ${JSON.stringify(kind)}`,
        ms
    );

// a card's flat text: the host's, or the element a selector names inside it
const cardText = (h, sel) =>
    h.ev(`(() => { ${FLAT} const host = ${HOST}; return flat(${sel ? `host?.querySelector(${JSON.stringify(sel)})` : "host"}); })()`);

// the column under the cards' compact width, and back; the host measures itself, so the cards follow
async function narrow(h) {
    await h.ev(`(() => { const c = ${COLUMN}; if (c) c.style.maxWidth = "${NARROW_PX}px"; return true; })()`);
    return polishWaitFor(h, `${HOST}?.hasAttribute("data-compact") === true`, WAIT_MS);
}

async function widen(h) {
    await h.ev(`(() => { const c = ${COLUMN}; if (c) c.style.maxWidth = ""; return true; })()`);
    return polishWaitFor(h, `${HOST}?.hasAttribute("data-compact") === false`, WAIT_MS);
}

// records each agentprompt and judge stop and answers it in the page; idempotent
const recordSends = (h) =>
    h.ev(`(() => {
        const c = window.TabRpcClient;
        if (!c) return false;
        if (c.__rbsOrig) return true;
        c.__rbsOrig = c.wshRpcCall;
        const call = c.wshRpcCall.bind(c);
        window.__rbsSent = [];
        c.wshRpcCall = (command, data, opts) => {
            if (command === "agentprompt" || command === "brainstormjudgestop") {
                window.__rbsSent.push({ command, block: data?.blockid, text: data?.text ?? null });
                return Promise.resolve(null);
            }
            return call(command, data, opts);
        };
        return true;
    })()`);

const stopRecording = (h) =>
    h.ev(`(() => {
        const c = window.TabRpcClient;
        if (c?.__rbsOrig) {
            c.wshRpcCall = c.__rbsOrig;
            delete c.__rbsOrig;
        }
        return true;
    })()`);

// the lines sent to the agent since recordSends, as prompts
const sentLines = async (h) =>
    ((await h.ev(`window.__rbsSent ?? []`)) ?? []).filter((s) => s.command === "agentprompt").map((s) => s.text);

// waits for the n-th line (0-based) sent since recordSends; null past the wait
async function waitSent(h, n, ms = WAIT_MS) {
    for (const start = Date.now(); Date.now() - start < ms; await polishNap(150)) {
        const lines = await sentLines(h);
        if (lines.length > n) return lines[n];
    }
    return null;
}

// the brainstorm's answer records (brainstormAnswersAtom) for the fixture's file
const answerRecords = (h, ctx) =>
    agentPage(
        h,
        `const S = await mod("app/view/agents/brainstormstore.ts");
        const all = globalStore.get(S.brainstormAnswersAtom);
        const want = ${JSON.stringify(ctx.file)}.replace(/\\\\/g, "/").toLowerCase();
        const key = Object.keys(all).find((k) => k.replace(/\\\\/g, "/").toLowerCase() === want);
        return key ? all[key] : [];`
    );

// the agent ending its turn: idle since now, which settles a line it was sent
const agentIdle = (h, ctx) =>
    agentPage(
        h,
        `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.agentId)}, { state: "idle", idleSince: Date.now() });
        return true;`
    );

async function teardown(h, ctx) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`${ctx.name} teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    await step("stop recording sends", () => stopRecording(h));
    await step("stop watching for the Brainstorm tab", () =>
        h.ev(`(() => {
            const id = ${JSON.stringify(ctx.agentId ?? "")};
            window.__rbsNoTab?.[id]?.();
            delete window.__rbsNoTab?.[id];
            return true;
        })()`)
    );
    await step("restore the roster", () => restoreRoster(h));
    await step("drop the focus", () => agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`));
    await step("close the tabs", () => closeTabs(h, ctx));
    await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    await step("go home", () => h.goto("cockpit"));
}

// a scenario on one fixture agent: arrange with opts, then check(h, ctx, step) records each step; a step that throws
// is one FAIL, not the end of the run
function scenario(name, opts, check) {
    return {
        name,
        surface: "agent",
        arrange: (h) => arrange(h, name, opts),
        async assert(h, ctx) {
            if (ctx.arrangeError != null) return [skipStep(name, `could not verify: ${ctx.arrangeError}`)];
            const steps = [];
            const step = async (label, fn) => {
                try {
                    const [ok, detail] = await fn();
                    steps.push({ step: label, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
                } catch (e) {
                    steps.push({ step: label, ok: false, detail: `threw: ${e?.message ?? e}` });
                }
            };
            await check(h, ctx, step);
            return steps;
        },
        teardown,
    };
}

export const RBS_KIT = {
    scenario,
    writeFile,
    writeBoard,
    readHost,
    waitCard,
    cardText,
    narrow,
    widen,
    recordSends,
    sentLines,
    waitSent,
    answerRecords,
    agentIdle,
    closePaneTabs,
    agentPage,
    polishWaitFor,
    polishNap,
    HOST,
    PANE,
    RV,
    WAIT_MS,
    BS_POLL_WAIT_MS,
};

// --- rendered-bs-host: the host under the timeline, its card slot trading kinds, and openBrainstormAt -------------
const HOST_WORKING = bsFile({
    working: "Writing “When it pages” from your answer.",
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "guess", thresholds: "asked" }),
    history: BS_HISTORY,
});
const HOST_ASKING = { ...HOST_WORKING, working: null, question: BS_Q4 };
const OPEN_PART = "constraints";
const SHOT = (n, what) => `cdp-shots/rendered-bs-host-${n}-${what}.png`;

const renderedBsHost = scenario("rendered-bs-host", { file: HOST_WORKING }, async (h, ctx, step) => {
    await step("the agent's transcript draws in Rendered with the brainstorm host under the timeline, its slot empty while the agent works", async () => {
        await polishWaitFor(h, `(${RV}?.querySelector("[data-rendered-feed]")?.innerText ?? "").includes("lag alerts")`, WAIT_MS);
        const s = await readHost(h);
        await h.shot(SHOT(1, "working"));
        return [s.host && s.lastInColumn && s.belowFeed && s.kind === "none" && s.feed.includes("I'll ask as we go."), s];
    });

    await step("the file rewritten from working to a question swaps the slot to the question card", async () => {
        writeFile(ctx, HOST_ASKING);
        const swapped = await waitCard(h, "question");
        const s = await readHost(h);
        await h.shot(SHOT(2, "question"));
        return [swapped && s.lastInColumn, s];
    });

    await step("the column under 600px puts the host in its compact sizes, and back", async () => {
        const narrowed = await narrow(h);
        const at = await readHost(h);
        const widened = await widen(h);
        return [narrowed && at.width < 600 && widened, { narrowed, width: at.width, widened }];
    });

    await step("openBrainstormAt with a part opens the Brainstorm tab beside the transcript, that part's row open and in view", async () => {
        const opened = await agentPage(
            h,
            `const S = await mod("app/view/agents/brainstormstore.ts");
            S.openBrainstormAt(${JSON.stringify(ctx.agentId)}, { part: ${JSON.stringify(OPEN_PART)} });
            return true;`
        );
        const sel = `${PANE}?.querySelector('[data-brainstorm-part="${OPEN_PART}"]')`;
        const shown = await polishWaitFor(h, `!!${sel}`, WAIT_MS);
        // the scroll is smooth: give it time to land before judging the row's place
        await polishWaitFor(
            h,
            `${sel}?.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded") === "true"`,
            WAIT_MS
        );
        // the scroll is smooth, and the tab's pane widens as it opens: wait for the row to land before judging it
        await polishWaitFor(
            h,
            `(() => {
                const el = ${sel};
                let sc = el?.parentElement;
                while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
                const r = el?.getBoundingClientRect();
                const v = (sc ?? document.documentElement).getBoundingClientRect();
                return r != null && r.top >= v.top - 1 && r.top < v.bottom;
            })()`,
            WAIT_MS
        );
        await polishNap(300);
        const row = await h.ev(`(() => {
            const el = ${sel};
            const toggle = el?.querySelector("[data-brainstorm-row-toggle]");
            let sc = el?.parentElement;
            while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            const r = el?.getBoundingClientRect();
            const v = (sc ?? document.documentElement).getBoundingClientRect();
            return {
                expanded: toggle?.getAttribute("aria-expanded") ?? null,
                inView: r != null && r.top >= v.top - 1 && r.top < v.bottom,
                rendered: ${RV} != null,
            };
        })()`);
        await h.shot(SHOT(3, "pane-part"));
        const back = await closePaneTabs(h, ctx);
        return [opened && shown && row.expanded === "true" && row.inView && row.rendered && back, { shown, ...row, back }];
    });
});

export const RENDERED_BS_SCENARIOS = [
    renderedBsHost,
    ...question(RBS_KIT),
    ...boards(RBS_KIT),
    ...mockup(RBS_KIT),
    ...rows(RBS_KIT),
    ...composer(RBS_KIT),
    ...design(RBS_KIT),
    ...check(RBS_KIT),
    ...review(RBS_KIT),
    ...run(RBS_KIT),
];
