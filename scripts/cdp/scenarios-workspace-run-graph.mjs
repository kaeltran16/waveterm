// Scenario `workspace-run-graph`: the Run tab's Graph view (docs/superpowers/plans/2026-11-18-run-tab-polish.md;
// boards Main, Graph and Done). The run and the lead that links it are the shared fixture's (workspace-run-fixture.mjs);
// the 21 and 39-task dags are the Graph board's (Graph.dc.html's FD.b and FD.c), seeded over the fixture's dag and
// replaced by it again after. The Report-link step adds a worker for t-3 whose transcript holds its complete call.

import { makeTab, setRoster, toolResult, toolUse, userText, writeTranscript, focusAgent } from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor } from "./scenarios-shared.mjs";
import {
    arrange,
    CHANNEL,
    childRunId,
    clickAt,
    DAG_ID,
    openRunTab,
    page,
    pickView,
    PLAN,
    QUESTION,
    reseed,
    RUN_ID,
    RUN_TAB,
    RV,
    SETTLE_MS,
    stepper,
    TAB_KEY,
    teardown,
    TITLE,
    WAIT_MS,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-run-graph";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const GRAPH = `${RUN_TAB}?.querySelector("[data-workspace-run-graph]")`;
const ROW = (id) => `${GRAPH}?.querySelector('[data-graph-row="${id}"]')`;
const NODE = (id) => `${GRAPH}?.querySelector('[data-graph-node="${id}"]')`;
const CHIP = (id) => `${GRAPH}?.querySelector('[data-graph-chip="${id}"]')`;
const BACK = `${GRAPH}?.querySelector("[data-graph-back]")`;
const OPEN_DAG = `${RUN_TAB}?.querySelector("[data-workspace-run-open-dag]")`;

const LANE_ORDER = ["t-1", "t-3", "t-4", "t-7", "t-8", "t-2", "t-5", "t-6"];
const MAIN_FLIGHT = ["t-3", "t-6", "t-2", "t-4", "t-5"];
// the Graph board's short words for the Main fixture
const MAIN_WORDS = { "t-1": "merged", "t-3": "asked the lead", "t-4": "working", "t-7": "waits", "t-8": "waits", "t-2": "working", "t-5": "working", "t-6": "failed" };
const MAIN_NAMES = {
    "t-1": "internal/stats counters",
    "t-3": "internal/dedupe groups",
    "t-7": "go test and go vet",
};
// the Lanes board's row text: a timed word, what a waiting task waits on, or the bare word
const timed = (id) => (w) => w?.startsWith(`${MAIN_WORDS[id]} · `);
const LANE_WORDS = {
    "t-1": (w) => w === "merged",
    "t-3": timed("t-3"),
    "t-4": timed("t-4"),
    "t-7": (w) => w === "waits on t-3, t-4",
    "t-8": (w) => w === "waits",
    "t-2": timed("t-2"),
    "t-5": timed("t-5"),
    "t-6": (w) => timed("t-6")(w) && w.endsWith(" ago"),
};
const DONE_SHOTS_WORD = "passed · 6 scenarios";
const T3_SHA = "9b8c7d6";

// Graph.dc.html's FD.b and FD.c: [label, deps by number, the board's state]
const DAG_21 = [
    ["Detector: record the rule half of a decision (migration 078)", [], "merged"],
    ["MP: the Findings list, summary and detail reads", [1], "live"],
    ["MP: the Route read with the token map restored", [2], "waits"],
    ["MP: one decision per finding", [2], "waits"],
    ["MP: approved rules carry their finding and scenario", [], "merged"],
    ["Webapp: routes, hooks and fixtures for the findings", [], "merged"],
    ["Webapp: the Findings list and its view helpers", [6], "asked"],
    ["Webapp: the Finding and Claims tabs", [6], "live"],
    ["Webapp: the Route tab", [6], "failed"],
    ["Webapp: the Why investigated tab", [6], "live"],
    ["Webapp: the Rules tab", [6], "live"],
    ["Webapp: the finding drawer and its decision bar", [7, 8, 9, 10], "waits"],
    ["Webapp: the page swap and the old tabs' removal", [11, 12], "waits"],
    ["Scenario: the Findings list", [13], "waits"],
    ["Scenario: the finding drawer's tabs", [13], "waits"],
    ["Scenario: the decision and the Rules tab", [13], "waits"],
    ["Locales: the six new files in the other 20 locales", [13], "waits"],
    ["Webapp: the Route tab reads a missing step count as a dash", [], "merged"],
    ["Webapp: the decision bar drops a pick that is no longer offered", [], "merged"],
    ["Webapp: a mode switch never shows the previous mode's rows", [], "merged"],
    ["Webapp: drop the candidate hooks and routes nothing calls", [], "merged"],
];
const DAG_39 = [
    ["Response cache key sensitivity tests (tests 4)", [], "merged"],
    ["ui_event registry, clarification round trip, redaction e2e tests (tests 5-7)", [], "merged"],
    ["JWT purpose tokens, required claims, admin by right, settings hygiene (sec 2, 6, 13)", [], "merged"],
    ["Mandatory redaction turn and unregistered entry points (#4)", [], "merged"],
    ["Failures reported as not found or no results (tools 2, 3, 7)", [], "merged"],
    ["CE and whitelist grammar templates (prompts 1, 12)", [], "merged"],
    ["Graph-to-SSE, initial state and finalize-in-graph tests (tests 1-3)", [1], "merged"],
    ["Planner output contract and verdict grounding keys (prompts 5, 6)", [], "merged"],
    ["Cache layer: atomic incr and set_if_absent", [], "merged"],
    ["Enforce permissions in the agent loop and on the chatbot routers (tools 6, sec 4)", [3], "merged"],
    ["Response cache: original question on a pick, no session-state answers, persist on hit (#3, tools 18)", [2, 7], "merged"],
    ["Analysis over a different scope uses the user's window (tools 1)", [5, 10], "merged"],
    ["Forced query conversion collapses agent turns (#2, tools 5, prompts 2)", [8, 12], "merged"],
    ["Rate limiting, body size limits, feedback ownership (sec 3, 7, 8)", [10, 4, 9], "merged"],
    ["Tokeniser logic bugs (redaction 8-11, 13-14, prompts 3-4)", [4, 13], "live"],
    ["Expired pending card hard error (T6)", [11, 5], "merged"],
    ["Session ownership claim, fail closed (sec 5)", [9, 10, 4], "merged"],
    ["Query-analysis cache scoped to the caller (tools 15)", [12], "merged"],
    ["Time handling: one extractor, analyst timezone (tools 8, 9, #9 divergence, tools 18 clamp)", [16, 17], "asked"],
    ["Threat-intel verdicts: domain floor, IP ranges, dropped inputs (tools 4, 13)", [5], "merged"],
    ["Rule and whitelist validation loops (tools 10)", [5], "merged"],
    ["Alert verdict supersedes only alert-only turns (#1)", [], "merged"],
    ["Tool budgets, entity-kind gate, observation truncation (tools 12, 14, 16, 17)", [20, 15, 18, 21], "waits"],
    ["Filter-to-query escaping and field validator (tools 11, 19)", [23, 19], "waits"],
    ["Prompt injection: delimit log values, findings, exemplars (prompts 7)", [15, 21], "waits"],
    ["Single per-turn artifact sink for ui_events (#5)", [22, 23, 19], "waits"],
    ["Prompt cleanup: dead templates, duplicates, contracts, evaluator (prompts 8-11, 13-16)", [25, 6, 24, 26], "waits"],
    ["Node error boundary and safe error text (#6, T2)", [26], "waits"],
    ["Finalize lifecycle: per-turn handle, start/stop drain (#8)", [28], "waits"],
    ["Security hygiene and router error text (sec 9-12, 14-16)", [29, 14], "waits"],
    ["Delete the ineffective transient cleanup (#7)", [29], "waits"],
    ["Composition root and dead code removal (#9, T5)", [30, 31], "waits"],
    ["Tests cleanup: vacuous tests, dead-code tests, suite mechanics (tests 8-10)", [32], "waits"],
    ["Tactical: T1 T3 T4 T7, tools 20, doc drift (T8)", [33, 27], "waits"],
    ["Respond-time tests pin removed fields", [], "merged"],
    ["Session owner claim lives as long as the session's data", [35], "merged"],
    ["Analysis-tool tests reach the network", [36], "merged"],
    ["Shutdown is bounded and drains every background task", [36], "merged"],
    ["Feedback ownership lookup reports database errors as 503", [], "merged"],
];

// a board's tasks as the engine records them: merged, live (running), asked (running, with the lead), failed, waits
const ENGINE = { merged: { state: "done", merged: true }, live: { state: "running" }, asked: { state: "running" }, failed: { state: "failed" }, waits: { state: "pending" } };
const boardDag = (rows) =>
    rows.map(([label, deps, s], i) => ({
        id: `t-${i + 1}`,
        label,
        ...(deps.length ? { deps: deps.map((d) => `t-${d}`) } : {}),
        ...ENGINE[s],
    }));
const boardDigest = (rows) => ({
    health: "attention",
    counts: {},
    next: { kind: "waiting" },
    tasks: rows.map(([, , s], i) => ({ taskid: `t-${i + 1}`, waitreason: s === "asked" ? "lead-ask" : "", mergestate: "", cleanupstate: "" })),
});

// puts a board's dag over the fixture's (same oid, a newer version) with its digest; reseed puts the fixture back
async function seedBoard(h, ctx, rows) {
    ctx.version += 1;
    const dag = {
        otype: "dag",
        oid: DAG_ID,
        id: DAG_ID,
        version: ctx.version,
        runid: RUN_ID,
        channelid: CHANNEL,
        title: TITLE,
        parallelism: 4,
        status: "running",
        failures: 0,
        createdts: Date.now() - 20 * 60_000,
        updatedts: Date.now(),
        planpath: PLAN,
        planreview: { state: "passed", round: 1 },
        tasks: boardDag(rows),
    };
    return page(
        h,
        `const L = await mod("app/view/agents/runlineagestore.ts");
        WOS.updateWaveObject({ updatetype: "update", otype: "dag", oid: ${JSON.stringify(DAG_ID)}, obj: ${JSON.stringify(dag)} });
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: { dagversion: ${ctx.version}, ...${JSON.stringify(boardDigest(rows))} } }));
        return true;`
    );
}

// the Graph view as drawn: mode, the bar, Lanes' rows, gutter and stages, Focus' nodes
const readGraph = (h) =>
    page(
        h,
        `const g = ${GRAPH};
        if (!g) return null;
        const all = (sel) => [...g.querySelectorAll(sel)];
        const word = (el) => flat(el?.querySelector("[data-graph-word]") ?? el?.querySelector("[data-graph-stage-word]"));
        const stage = (name) => g.querySelector('[data-graph-stage="' + name + '"]');
        return {
            mode: g.dataset.graphMode,
            chips: all("[data-graph-chip]").map((c) => c.dataset.graphChip),
            pressed: all('[data-graph-chip][aria-pressed="true"]').map((c) => c.dataset.graphChip),
            back: flat(g.querySelector("[data-graph-back]")),
            modePick: g.querySelector('[data-graph-mode-pick][aria-selected="true"]')?.dataset.graphModePick ?? null,
            rows: all("[data-graph-row]").map((r) => r.dataset.graphRow),
            words: Object.fromEntries(all("[data-graph-row]").map((r) => [r.dataset.graphRow, word(r)])),
            hints: all("[data-graph-focus-hint]").map((x) => [x.closest("[data-graph-row]")?.dataset.graphRow ?? null, flat(x)]),
            names: Object.fromEntries(all("[data-graph-row]").map((r) => [r.dataset.graphRow, flat(r.querySelector("span:nth-child(2)") ?? r.children[1])])),
            lit: all('[data-graph-row][data-lit="1"]').map((r) => r.dataset.graphRow),
            dim: all('[data-graph-row][data-lit="0"]').map((r) => r.dataset.graphRow),
            selected: all('[data-graph-row][data-selected="1"]').map((r) => r.dataset.graphRow),
            edges: all("[data-graph-edge]").length,
            litEdges: all('[data-graph-edge][data-lit="1"]').map((e) => e.dataset.graphEdge),
            laneCount: Number(g.querySelector("[data-graph-lanes]")?.dataset.laneCount ?? 0),
            dots: Object.fromEntries(all("[data-graph-dot]").map((d) => [d.dataset.graphDot, d.className.includes("bg-success") ? "merged" : "other"])),
            planReview: stage("plan-review") ? word(stage("plan-review")) : null,
            final: stage("final") ? word(stage("final")) : null,
            focus: g.querySelector("[data-graph-focus]")?.dataset.graphFocus ?? null,
            up: all('[data-graph-node][data-side="up"]').map((n) => n.dataset.graphNode),
            down: all('[data-graph-node][data-side="down"]').map((n) => n.dataset.graphNode),
            stageNodes: all("[data-graph-node-stage]").map((n) => n.dataset.graphNodeStage),
            more: Object.fromEntries(all("[data-graph-more]").map((m) => [m.dataset.graphMore, flat(m)])),
            labels: Object.fromEntries(all("[data-graph-row-label]").map((l) => [l.dataset.graphRowLabel, flat(l)])),
            nodeWords: Object.fromEntries(all("[data-graph-node-word]").map((w) => [w.closest("[data-graph-node]").dataset.graphNode, flat(w)])),
            hint: flat(g.querySelector("[data-graph-hint]")),
        };`
    );

// the Focus centre card as drawn, and the board's height against its lowest node's bottom
const readFocus = (h) =>
    page(
        h,
        `const g = ${GRAPH};
        const c = g?.querySelector("[data-focus-card]");
        const b = g?.querySelector("[data-graph-board]");
        if (!c || !b) return null;
        const top = b.getBoundingClientRect().top;
        const lowest = Math.max(...[...b.querySelectorAll("[data-graph-node], [data-graph-node-stage]")].map((n) => n.getBoundingClientRect().bottom - top));
        // a button's content height over one line of its own text: 1 when nothing wraps
        const lines = (el) => {
            const cs = getComputedStyle(el);
            const content = el.getBoundingClientRect().height - ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((n, k) => n + parseFloat(cs[k]), 0);
            const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
            const r = document.createRange();
            r.selectNodeContents(text);
            return Math.round(content / r.getClientRects()[0].height);
        };
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        const agent = c.querySelector("[data-open-agent]");
        const changes = c.querySelector("[data-open-changes]");
        const diff = c.querySelector("[data-focus-diff]");
        const actions = [agent, changes, diff].filter(Boolean);
        return {
            id: c.dataset.focusCard,
            warning: c.className.includes("border-warning"),
            state: flat(c.querySelector("[data-focus-state]")),
            steps: [...c.querySelectorAll("[data-body-steps] [data-steps] > div")].map(flat),
            question: flat(c.querySelector("[data-focus-question]")),
            starts: flat(c.querySelector("[data-focus-starts]")),
            diff: flat(diff),
            openAgent: agent != null,
            openChanges: changes != null,
            buttonLines: [agent, changes].filter(Boolean).map(lines),
            actionsSpread: actions.length ? Math.max(...actions.map(mid)) - Math.min(...actions.map(mid)) : 0,
            height: b.getBoundingClientRect().height,
            lowest,
        };`
    );
const boardFits = (f) => f != null && Math.abs(f.height - f.lowest) <= 1 && f.height < 460;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settle = () => polishNap(SETTLE_MS);

async function clickSettled(h, expr) {
    const ok = await clickAt(h, expr);
    await settle();
    return ok;
}

// a real mouse over the centre of what expr names, so the row's own mouseenter fires
async function hover(h, expr) {
    const at = await h.ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (at == null) return false;
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await polishNap(200);
    return true;
}

// Esc as the window-capture dispatcher sees it, from whatever holds focus (a clicked button, or the body)
const pressEscape = async (h) => {
    await h.ev(`(() => { const t = document.activeElement ?? document.body; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); return true; })()`);
    await settle();
};

const surface = (h) => page(h, `return globalStore.get(agentsModel().surfaceAtom);`);

const dagModal = (h) =>
    page(
        h,
        `const M = await mod("app/view/orchestrate/dagmodalstate.ts");
        const S = await mod("app/view/orchestrate/dagstore.ts");
        // open means drawn: the state atom alone once read open while no surface mounting the modal was showing
        const drawn = await until(() => document.querySelector("[data-dag-modal-kind]") != null, 3000);
        return { open: globalStore.get(M.dagModalStateAtom) != null && drawn, task: globalStore.get(S.selectedTaskIdAtom) ?? null };`
    );
const closeDag = (h) => page(h, `const M = await mod("app/view/orchestrate/dagmodalstate.ts"); M.closeDagModal(); await nap(300); return true;`);

const setGraph = (h, agentId, graph) =>
    page(h, `W.updateWorkspaceTab(${JSON.stringify(agentId)}, ${JSON.stringify(TAB_KEY)}, { view: "graph", graph: ${JSON.stringify(graph)} }); return true;`);

// the transcript loads after the view draws, so keep opening its folds until what is wanted inside one shows
const openFoldsUntil = (h, expr) =>
    page(
        h,
        `return await until(() => {
            [...(${RV}?.querySelectorAll('[data-fold][aria-expanded="false"]') ?? [])].forEach((f) => f.click());
            return ${expr} != null;
        }, ${WAIT_MS});`
    );

export const workspaceRunGraph = {
    name: NAME,
    surface: "agent",
    arrange: (h) => arrange(h, NAME),
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        const LEAD = ctx.leadId;

        await step("the segmented control opens Graph on the Main fixture", async () => {
            const opened = await openRunTab(h);
            const t = await pickView(h, "graph");
            const drawn = await h.ev(`${GRAPH} != null`);
            await h.shot(SHOT(1, "graph"));
            return [opened && t.view === "graph" && t.indicator === "graph" && drawn, { opened, view: t.view, fill: t.indicator, drawn }];
        });

        await step("Lanes: Plan review, 8 rows in order t-1, t-3, t-4, t-7, t-8, t-2, t-5, t-6 with names and words, a 3-lane gutter, Final verification, In flight chips t-3, t-6, t-2, t-4, t-5 (Main and Graph boards)", async () => {
            const g = await readGraph(h);
            await h.shot(SHOT(2, "lanes"));
            const names = Object.entries(MAIN_NAMES).every(([id, n]) => g?.names[id] === n);
            const ok =
                g?.mode === "lanes" &&
                g.modePick === "lanes" &&
                g.planReview === "passed" &&
                same(g.rows, LANE_ORDER) &&
                same(Object.keys(g.words).sort(), Object.keys(LANE_WORDS).sort()) &&
                Object.entries(LANE_WORDS).every(([id, ok]) => ok(g.words[id])) &&
                names &&
                g.laneCount === 3 &&
                g.edges === 5 &&
                g.final === "waits for every task" &&
                same(g.chips, MAIN_FLIGHT) &&
                g.back === "";
            return [ok, g];
        });

        await step("hovering t-3 lights t-1, t-3, t-7 and their edges and dims the rest", async () => {
            const hovered = await hover(h, ROW("t-3"));
            const g = await readGraph(h);
            await h.shot(SHOT(3, "hover-chain"));
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
            await polishNap(200);
            const after = await readGraph(h);
            const ok =
                hovered &&
                same([...g.lit].sort(), ["t-1", "t-3", "t-7"]) &&
                same([...g.litEdges].sort(), ["t-1>t-3", "t-3>t-7"]) &&
                g.dim.length === 5 &&
                after.dim.length === 0;
            return [ok, { lit: g.lit, litEdges: g.litEdges, dim: g.dim, dimAfter: after.dim }];
        });

        await step("hovering t-4 shows Focus → on its row and on no other (Lanes board)", async () => {
            const hovered = await hover(h, ROW("t-4"));
            const g = await readGraph(h);
            await h.shot(SHOT(3, "hover-focus-hint"));
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
            await polishNap(200);
            const after = await readGraph(h);
            const ok = hovered && same(g?.hints, [["t-4", "Focus →"]]) && after?.hints.length === 0;
            return [ok, { hints: g?.hints, after: after?.hints }];
        });

        await step("Focus on t-4: working · <time>, its latest step, Open agent, no Open changes; t-1 above reads merged, t-7 below reads waits; labels waits on 1 / then 1 (Focus-Working board)", async () => {
            const T4 = JSON.stringify(childRunId("t-4"));
            const worker = writeTranscript(ctx.dir, `${NAME}-t4-worker`, [
                userText("Add linkshelf stats over internal/stats."),
                toolUse("toolu_t4_1", "Read", { file_path: "internal/stats/counters.go" }),
                toolResult("toolu_t4_1", "package stats"),
                toolUse("toolu_t4_2", "Bash", { command: "go build ./...", description: "build" }),
            ]);
            // only t-4's run has a transcript; a cached lookup is dropped, so the card asks again
            await page(
                h,
                `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                const L = await mod("app/view/agents/runlineagestore.ts");
                RpcApi.RunTranscriptPathCommand = async (_client, data) => (data.runid === ${T4} ? ${JSON.stringify(worker)} : "");
                globalStore.set(L.runTranscriptPathsAtom, (prev) => { const next = { ...prev }; delete next[${T4}]; return next; });
                return true;`
            );
            // put back once read, so no later step's transcript lookup meets the stub
            const unstub = (hh) =>
                page(
                    hh,
                    `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                    const L = await mod("app/view/agents/runlineagestore.ts");
                    delete RpcApi.RunTranscriptPathCommand;
                    globalStore.set(L.runTranscriptPathsAtom, (prev) => { const next = { ...prev }; delete next[${T4}]; return next; });
                    return true;`
                );
            ctx.cleanups.push(unstub);
            await clickSettled(h, CHIP("t-4"));
            const drawn = await polishWaitFor(h, `${GRAPH}?.querySelectorAll("[data-focus-card] [data-body-steps] [data-steps] > div").length === 1`, WAIT_MS);
            await settle();
            const g = await readGraph(h);
            const f = await readFocus(h);
            await h.shot(SHOT(3, "focus-working-t4"));
            await unstub(h);
            const ok =
                drawn &&
                g?.focus === "t-4" &&
                f?.id === "t-4" &&
                /^working · \d+m$/.test(f.state) &&
                f.steps.length === 1 &&
                f.steps[0].includes("go build") &&
                f.openAgent &&
                !f.openChanges &&
                f.diff === "" &&
                same(g.up, ["t-1"]) &&
                same(g.down, ["t-7"]) &&
                g.nodeWords["t-1"] === "merged" &&
                g.nodeWords["t-7"] === "waits" &&
                same(g.labels, { up: "waits on 1", down: "then 1" }) &&
                g.hint === "click a task to move to it · Esc for Lanes" &&
                boardFits(f);
            return [ok, { drawn, focus: g?.focus, up: g?.up, down: g?.down, nodeWords: g?.nodeWords, labels: g?.labels, hint: g?.hint, card: f }];
        });

        await step("Focus on t-4 with a live worker: its live diff stat and Open changes, which focuses the worker and opens its own diff (Focus-Working board, t-4)", async () => {
            const W = `${NAME}-t4-live`;
            // no transcript, so the shell's git tracking leaves the seeded stat alone
            const roster = await page(h, `const D = await mod("app/view/agents/devmock.ts"); return globalStore.get(D.devMockAgentsAtom);`);
            await setRoster(h, [
                ...roster,
                { id: W, name: W, project: "linkshelf", task: "linkshelf stats", state: "working", agent: "claude", model: "claude-opus-5-5", runId: childRunId("t-4") },
            ]);
            ctx.version += 1;
            await page(
                h,
                `const CG = await mod("app/view/agents/cardgitstore.ts");
                const prev = globalStore.get(WOS.getWaveObjectAtom("run:" + ${JSON.stringify(childRunId("t-4"))}));
                WOS.updateWaveObject({ updatetype: "update", otype: "run", oid: prev.oid, obj: { ...prev, version: ${ctx.version}, phases: [{ workerorefs: ["tab:" + ${JSON.stringify(W)}] }] } });
                globalStore.set(CG.diffStatsByIdAtom, (s) => ({ ...s, ${JSON.stringify(W)}: { files: 3, adds: 40, dels: 2 } }));
                return true;`
            );
            const restore = async (hh) => {
                await page(hh, `const CG = await mod("app/view/agents/cardgitstore.ts"); globalStore.set(CG.diffStatsByIdAtom, (s) => { const { [${JSON.stringify(W)}]: _, ...rest } = s; return rest; }); return true;`);
                await setRoster(hh, roster);
            };
            ctx.cleanups.push(restore);
            const drawn = await polishWaitFor(h, `${GRAPH}?.querySelector("[data-focus-card] [data-open-changes]") != null`, WAIT_MS);
            const f = await readFocus(h);
            await h.shot(SHOT(3, "focus-live-diff-t4"));
            await page(h, `window.__fxDiffScope = globalStore.get(agentsModel().diffScopeAtom); return true;`);
            const clicked = await clickSettled(h, `${GRAPH}?.querySelector("[data-focus-card] [data-open-changes]")`);
            const opened = await page(
                h,
                `const m = agentsModel();
                const at = { surface: globalStore.get(m.surfaceAtom), focus: globalStore.get(m.focusIdAtom), origin: globalStore.get(m.diffScopeAtom)?.repo?.origin ?? null };
                globalStore.set(m.diffScopeAtom, window.__fxDiffScope);
                delete window.__fxDiffScope;
                return at;`
            );
            await restore(h);
            await reseed(h, ctx);
            await focusAgent(h, LEAD);
            await polishWaitFor(h, `${GRAPH}?.querySelector('[data-focus-card="t-4"]') != null`, WAIT_MS);
            await settle();
            const ok =
                drawn &&
                f?.id === "t-4" &&
                f.openAgent &&
                f.openChanges &&
                f.diff === "3 files+40−2" &&
                same(f.buttonLines, [1, 1]) &&
                clicked &&
                opened?.surface === "files" &&
                opened.focus === W &&
                opened.origin?.kind === "agent" &&
                opened.origin.id === W;
            return [ok, { drawn, card: f, clicked, opened }];
        });

        await step("Focus on t-5: Open changes and its diff stat on one line with Open agent, no button wrapping (each action button's height is one line) (Focus-Working board, feedback 001)", async () => {
            await clickSettled(h, CHIP("t-5"));
            const f = await readFocus(h);
            await h.shot(SHOT(3, "focus-diff-t5"));
            const ok =
                f?.id === "t-5" &&
                f.openAgent &&
                f.openChanges &&
                f.diff === "2 files+210−31" &&
                same(f.buttonLines, [1, 1]) &&
                f.actionsSpread < 2 &&
                boardFits(f);
            return [ok, f];
        });

        await step("Focus on t-3: warning border, asked the lead · <time>, the fixture's question, Open agent (Focus-Asked board)", async () => {
            await clickSettled(h, CHIP("t-3"));
            const f = await readFocus(h);
            await h.shot(SHOT(3, "focus-asked-t3"));
            const ok =
                f?.id === "t-3" &&
                f.warning &&
                /^asked the lead · \d+m$/.test(f.state) &&
                f.question === QUESTION &&
                f.openAgent &&
                !f.openChanges &&
                boardFits(f);
            return [ok, f];
        });

        await step("Focus on t-7 from t-4 (back ← t-4): t-3 and t-4 above with their words, Starts once t-3 and t-4 merge., no actions, Final verification below labelled then (Focus-Waits board)", async () => {
            await clickSettled(h, CHIP("t-4"));
            await clickSettled(h, NODE("t-7"));
            const g = await readGraph(h);
            const f = await readFocus(h);
            await h.shot(SHOT(3, "focus-waits-t7"));
            // back to Lanes with no selection, as the steps below begin
            await setGraph(h, LEAD, { mode: "lanes", focus: null, trail: [] });
            await settle();
            const ok =
                g?.focus === "t-7" &&
                g.back === "← t-4" &&
                same(g.up, ["t-3", "t-4"]) &&
                g.nodeWords["t-3"] === "asked the lead" &&
                g.nodeWords["t-4"] === "working" &&
                f?.state === "waits" &&
                f.starts === "Starts once t-3 and t-4 merge." &&
                !f.openAgent &&
                same(g.stageNodes, ["final"]) &&
                same(g.labels, { up: "waits on 2", down: "then" }) &&
                boardFits(f);
            return [ok, { focus: g?.focus, back: g?.back, up: g?.up, nodeWords: g?.nodeWords, stages: g?.stageNodes, labels: g?.labels, card: f }];
        });

        await step("clicking t-7 opens Focus on it: t-3 and t-4 above, Final verification below", async () => {
            const clicked = await clickSettled(h, ROW("t-7"));
            const g = await readGraph(h);
            const fit = await readFocus(h);
            await h.shot(SHOT(4, "focus-t7"));
            const ok =
                clicked &&
                g?.mode === "focus" &&
                g.focus === "t-7" &&
                same(g.up, ["t-3", "t-4"]) &&
                same(g.down, []) &&
                same(g.stageNodes, ["final"]) &&
                g.labels.up === "waits on 2" &&
                g.labels.down === "then" &&
                g.back === "" &&
                boardFits(fit);
            return [ok, g && { mode: g.mode, focus: g.focus, up: g.up, down: g.down, stages: g.stageNodes, labels: g.labels, board: fit && [fit.height, fit.lowest] }];
        });

        await step("clicking t-3 moves there, back returns to t-7", async () => {
            await clickSettled(h, NODE("t-3"));
            const moved = await readGraph(h);
            await h.shot(SHOT(5, "focus-t3"));
            await clickSettled(h, BACK);
            const back = await readGraph(h);
            const ok =
                moved?.focus === "t-3" &&
                same(moved.up, ["t-1"]) &&
                same(moved.down, ["t-7"]) &&
                moved.back === "← t-7" &&
                back?.focus === "t-7" &&
                back.back === "";
            return [ok, { moved: moved && { focus: moved.focus, up: moved.up, down: moved.down, back: moved.back }, back: back && { focus: back.focus, back: back.back } }];
        });

        await step("an In flight chip jumps into Focus on its task", async () => {
            await clickSettled(h, NODE("t-3"));
            await clickSettled(h, CHIP("t-6"));
            const g = await readGraph(h);
            await h.shot(SHOT(6, "chip-t6"));
            const ok = g?.mode === "focus" && g.focus === "t-6" && same(g.pressed, ["t-6"]) && g.back === "" && same(g.stageNodes, ["plan-review", "final"]);
            return [ok, g && { focus: g.focus, pressed: g.pressed, back: g.back, stages: g.stageNodes }];
        });

        await step("Esc in Focus returns to Lanes; a second Esc leaves the Graph to the app's back", async () => {
            await pressEscape(h);
            const lanes = await readGraph(h);
            const stayed = await surface(h);
            await pressEscape(h);
            const left = await surface(h);
            await focusAgent(h, LEAD);
            const back = await polishWaitFor(h, `${GRAPH} != null`, WAIT_MS);
            await settle();
            const ok = lanes?.mode === "lanes" && same(lanes.selected, ["t-6"]) && stayed === "agent" && left !== "agent" && back;
            return [ok, { mode: lanes?.mode, selected: lanes?.selected, stayed, left, back }];
        });

        await step("Open DAG in Lanes opens the run's DAG with no task selected, and in Focus on the focused task", async () => {
            const inLanes = await readGraph(h);
            await clickAt(h, OPEN_DAG);
            await settle();
            const lanesModal = await dagModal(h);
            await closeDag(h);
            await clickSettled(h, ROW("t-3"));
            await clickAt(h, OPEN_DAG);
            await settle();
            const focusModal = await dagModal(h);
            await h.shot(SHOT(7, "open-dag-focus"));
            await closeDag(h);
            const closed = await dagModal(h);
            const ok =
                inLanes?.mode === "lanes" &&
                lanesModal.open &&
                lanesModal.task == null &&
                focusModal.open &&
                focusModal.task === "t-3" &&
                !closed.open;
            return [ok, { mode: inLanes?.mode, lanesModal, focusModal, closed }];
        });

        await step("a seeded 21-task dag draws 21 rows, a 5-lane gutter and 5 In flight chips t-7, t-9, t-2, t-8, t-10 (Graph board)", async () => {
            await setGraph(h, LEAD, { mode: "lanes", focus: null, trail: [] });
            await seedBoard(h, ctx, DAG_21);
            await settle();
            const g = await readGraph(h);
            await h.shot(SHOT(8, "lanes-21"));
            const ok = g?.mode === "lanes" && g.rows.length === 21 && g.laneCount === 5 && same(g.chips, ["t-7", "t-9", "t-2", "t-8", "t-10"]);
            return [ok, g && { rows: g.rows.length, lanes: g.laneCount, chips: g.chips }];
        });

        await step("a seeded 39-task dag draws 39 rows and a 9-lane gutter, and a task with more than 3 dependents shows 2 and +N more (Graph board)", async () => {
            await seedBoard(h, ctx, DAG_39);
            await settle();
            const g = await readGraph(h);
            await h.shot(SHOT(9, "lanes-39"));
            // t-5 waits on nothing and has 4 dependents: t-12, t-16, t-20, t-21
            await clickSettled(h, ROW("t-5"));
            const f = await readGraph(h);
            const fit = await readFocus(h);
            await h.shot(SHOT(10, "focus-39-more"));
            const ok =
                g?.rows.length === 39 &&
                g.laneCount === 9 &&
                f?.focus === "t-5" &&
                same(f.down, ["t-12", "t-16"]) &&
                f.more.down === "+2 more" &&
                f.labels.down === "then 4" &&
                boardFits(fit);
            return [ok, { rows: g?.rows.length, lanes: g?.laneCount, focus: f?.focus, down: f?.down, more: f?.more, labels: f?.labels, board: fit && [fit.height, fit.lowest] }];
        });

        await step("with the Run tab open on Tasks, a wsh jarvis complete card's Report link for t-3 switches the tab to Graph in Focus on t-3", async () => {
            await reseed(h, ctx);
            const tag = Date.now().toString(36);
            const transcript = writeTranscript(ctx.dir, `${NAME}-worker-${tag}`, [
                userText("Build internal/dedupe groups."),
                toolUse("toolu_fx_done", "Bash", { command: `wsh jarvis complete --commit ${T3_SHA} --report C:/tmp/t-3.md`, description: "Complete the task" }),
                toolResult("toolu_fx_done", "run phase marked complete; the engine takes it from here"),
            ]);
            const worker = await makeTab(h, ctx, { label: `${NAME}-t-3-${tag}`, blockMeta: { view: "term", controller: null } });
            const WORKER = JSON.stringify(worker.tabId);
            // the card reads the run's dag status; the page-only run has none on the server, so answer from the page
            await page(
                h,
                `const R = await mod("app/store/wshclientapi.ts");
                const L = await mod("app/view/agents/runlineagestore.ts");
                if (!window.__fxDagStatus) window.__fxDagStatus = R.RpcApi.DagStatusCommand;
                const orig = window.__fxDagStatus;
                R.RpcApi.DagStatusCommand = async (client, data, opts) =>
                    data?.runid === ${JSON.stringify(RUN_ID)}
                        ? { group: globalStore.get(WOS.getWaveObjectAtom("dag:" + ${JSON.stringify(DAG_ID)})), digest: globalStore.get(L.runDigestsAtom)[${JSON.stringify(RUN_ID)}] }
                        : orig.call(R.RpcApi, client, data, opts);
                // the lead's cards already asked the server and cached its error; idle makes the next read ask again
                const D = await mod("app/view/agents/wshdata.ts");
                globalStore.set(D.wshDataAtom("dag:" + ${JSON.stringify(RUN_ID)}), { status: "idle" });
                return true;`
            );
            ctx.cleanups.push((hh) =>
                page(
                    hh,
                    `const R = await mod("app/store/wshclientapi.ts");
                    const D = await mod("app/view/agents/wshdata.ts");
                    if (window.__fxDagStatus) { R.RpcApi.DagStatusCommand = window.__fxDagStatus; delete window.__fxDagStatus; }
                    globalStore.set(D.wshDataAtom("dag:" + ${JSON.stringify(RUN_ID)}), { status: "idle" });
                    W.closeWorkspaceTab(${WORKER}, ${JSON.stringify(TAB_KEY)});
                    return true;`
                )
            );
            // the lead's roster entry as arrange set it, kept beside the worker and put back alone after
            const roster = await page(h, `const D = await mod("app/view/agents/devmock.ts"); return globalStore.get(D.devMockAgentsAtom);`);
            await setRoster(h, [
                ...roster,
                { id: worker.tabId, name: `${NAME}-t-3-${tag}`, project: "linkshelf", task: "internal/dedupe groups", state: "idle", agent: "claude", model: "claude-opus-5-5", blockId: worker.blockId, runId: childRunId("t-3"), transcriptPath: transcript },
            ]);
            await focusAgent(h, worker.tabId);
            const shown = await polishWaitFor(h, `${RV} != null`, WAIT_MS);
            const REPORT = `[...(${RV}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Report")`;
            const linked = await openFoldsUntil(h, REPORT);
            const seen = linked
                ? null
                : await page(
                      h,
                      `const D = await mod("app/view/agents/wshdata.ts");
                      return { role: agentsModel() && globalStore.get(agentsModel().lineageAtom).roles[${WORKER}], dag: globalStore.get(D.wshDataAtom("dag:" + ${JSON.stringify(RUN_ID)})).status, text: flat(${RV}).slice(0, 300) };`
                  );
            await page(h, `W.openWorkspaceTab(${WORKER}, { kind: "run", runId: ${JSON.stringify(RUN_ID)}, view: "tasks" }); return true;`);
            const onTasks = await polishWaitFor(h, `${RUN_TAB}?.querySelector('[role="tab"][aria-selected="true"]')?.dataset.runView === "tasks"`, WAIT_MS);
            await settle();
            const clicked = await clickSettled(h, REPORT);
            const g = await readGraph(h);
            const tab = await page(h, `return ws(${WORKER}).tabs.find((t) => t.kind === "run") ?? null;`);
            await h.shot(SHOT(11, "report-focus-t3"));
            await setRoster(h, roster);
            await focusAgent(h, LEAD);
            await polishWaitFor(h, `${RUN_TAB} != null`, WAIT_MS);
            const ok = shown && linked && onTasks && clicked && tab?.view === "graph" && tab.graph?.mode === "focus" && tab.graph.focus === "t-3" && g?.focus === "t-3";
            return [ok, { shown, linked, onTasks, clicked, tab, focus: g?.focus, seen }];
        });

        await step("finished run: every lane merged, the Final verification row reads as the Tasks view's, no In flight chips (Done board)", async () => {
            await setGraph(h, LEAD, { mode: "lanes", focus: null, trail: [] });
            await reseed(h, ctx, { finished: true });
            await settle();
            const g = await readGraph(h);
            const openDag = await h.ev(`${OPEN_DAG} != null`);
            await h.shot(SHOT(12, "done-lanes"));
            const ok =
                g?.mode === "lanes" &&
                g.rows.length === 8 &&
                Object.values(g.dots).every((d) => d === "merged") &&
                Object.values(g.words).every((w) => w === "merged") &&
                g.final === DONE_SHOTS_WORD &&
                g.chips.length === 0 &&
                openDag;
            return [ok, g && { dots: g.dots, words: g.words, final: g.final, chips: g.chips, openDag }];
        });

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
