// Scenario `transcript-boards`: the wsh boards end to end. Each step rebuilds one prototype board's whole transcript
// from the families' exported `fixtures` plus the board's own prose and user entries, at the board's width (736 px
// column, or 380 px with `compact` for the card boards), then checks placement: change cards stand outside any step
// box, read-only calls are step rows that open to their view, wakes and briefs are Arc events (never a user bubble).

import { fixtures as dagActions } from "./scenarios-transcript-dagactions.mjs";
import { fixtures as agents } from "./scenarios-transcript-agents.mjs";
import { fixtures as arc } from "./scenarios-transcript-arc.mjs";
import { fixtures as dag } from "./scenarios-transcript-dag.mjs";
import { fixtures as initiative } from "./scenarios-transcript-initiative.mjs";
import { fixtures as notes, showFixture, transcriptNotes } from "./scenarios-transcript-notes.mjs";
import { fixtures as runs } from "./scenarios-transcript-runs.mjs";
import { bash, clearTranscript, prose, ROOT, tool, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const M = 60 * S;
const COLUMN = 736;
const CARD_WIDTH = 380;
// a board's rows fade in, and an opened step's body reveals, before a step reads them
const MOTION_MS = 700;
// the time between two sources' entries when a board does not say otherwise
const GAP_MS = 5 * S;
const SHOT_DIR = "cdp-shots";
// a step summary's computed colour: the text-muted and text-secondary @theme tokens
const MUTED_RGB = "rgb(127, 133, 139)";
const SECONDARY_RGB = "rgb(207, 213, 219)";
// the images the Jira board's attachments call saved, as wsh prints each saved path
const JIRA_IMAGES = ["image-20261109-030246.png", "image-20261109-030558.png", "image-20261109-030615.png"];
const JIRA_DIR = "C:\\Users\\kael\\AppData\\Local\\Temp\\arc-jira-SIEM-1748-2318840571\\";
const JIRA_SAVED = JIRA_IMAGES.map((n) => `${JIRA_DIR}${n}\n`).join("");
// the image each of the Jira board's reads returned
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const LEAD = dag.planSubmitted.ctx;
const RUN = LEAD.role.runId;
const CHANNEL = LEAD.channelId;
const HELD_LEAD = dag.runHeld.ctx;
const HELD_RUN = HELD_LEAD.role.runId;
const WORKER = dag.taskComplete.ctx;
const EFFORT = "f283ad11";

// ---- composing a board from fixtures ------------------------------------------------------------------------------

// a fixture re-keyed onto another run and channel, so cards from different families read one run's store
function remap(fixture, ids) {
    let json = JSON.stringify(fixture);
    for (const [from, to] of Object.entries(ids)) json = json.replaceAll(from, to);
    return JSON.parse(json);
}

const onDagRun = (f, runId = RUN) => remap(f, { "run-arc": runId, "ch-arc": CHANNEL, "run-dagactions": runId, "ch-dagactions": CHANNEL });

// a source is a fixture; its parts all shift by one amount, so the gaps inside it (and its run events) hold
const source = (fixture) => ({ fixture, shift: null });
const own = (entries, extra = {}) => source({ entries, ...extra });
// keep: which of the source's entries a part takes
const take = (src, keep = () => true, gap = GAP_MS) => ({ src, keep, gap });

const calls = (re) => (e) => e.kind === "action" && re.test(e.command ?? "");
const slice = (from, to) => (_, i) => i >= from && (to === undefined || i < to);
const users = (e) => e.kind === "user";
// a source of only some of a fixture's entries and none of its seeds or events, for a part that stands alone
const entriesOf = (fixture, keep) => own(fixture.entries.filter(keep));

const shiftEntry = (e, by) => ({
    ...e,
    ...(typeof e.ts === "number" ? { ts: e.ts + by } : {}),
    ...(typeof e.startedTs === "number" ? { startedTs: e.startedTs + by } : {}),
});

function chain(parts, { ctx, compact = false, width = COLUMN, seed = {}, runEvents = {}, brainstorm } = {}) {
    let clock = T0;
    const entries = [];
    const out = { entries, seed: {}, runEvents: {}, width, compact };
    if (ctx) out.ctx = ctx;
    if (brainstorm) out.brainstorm = brainstorm;
    const merged = new Set();
    for (const { src, keep, gap } of parts) {
        const { fixture } = src;
        const picked = fixture.entries.filter(keep);
        const stamps = picked.map((e) => e.ts).filter((t) => typeof t === "number");
        if (src.shift == null) src.shift = clock + gap - (stamps.length ? Math.min(...stamps) : 0);
        entries.push(...picked.map((e) => shiftEntry(e, src.shift)));
        for (const t of stamps) clock = Math.max(clock, t + src.shift);
        if (!stamps.length) clock += gap;
        if (merged.has(src)) continue;
        merged.add(src);
        Object.assign(out.seed, fixture.seed);
        for (const [runId, events] of Object.entries(fixture.runEvents ?? {})) {
            out.runEvents[runId] = [...(out.runEvents[runId] ?? []), ...events.map((ev) => ({ ...ev, ts: ev.ts + src.shift }))];
        }
    }
    Object.assign(out.seed, seed);
    for (const [runId, events] of Object.entries(runEvents)) out.runEvents[runId] = [...(out.runEvents[runId] ?? []), ...events];
    return out;
}

const wsh = (command, at, { output = "ok", durationMs = 250, description = command } = {}) =>
    bash({ description, command, output, ts: T0 + at * S, durationMs });
const reads = (...names) => names.map((n, i) => tool("read", n, { ts: T0 + (i + 1) * S }));

// ---- the data a board's calls read, drawn at the moment the board was drawn ---------------------------------------

// the run mid-way as the Build board draws it: two tasks landed, t-3 running, t-4 in review (or asking)
function runningDag(t4) {
    const live = dag.planSubmitted.seed[`dag:${RUN}`];
    const landed = dag.runLanded.seed[`dag:${RUN}`];
    const now = Date.now();
    const done = (t) => ({ ...t, state: "done", merged: true });
    const [t1, t2, t3, t4Task] = live.group.tasks;
    const tasks = [
        done(t1),
        done(t2),
        { ...t3, state: "running", firstactivity: now - 4 * M - 10 * S, lastactivity: now - 20 * S },
        t4 === "asks"
            ? { ...t4Task, state: "running", reviewround: 0 }
            : { ...t4Task, state: "reviewing", lastactivity: now - 2 * M - 11 * S, reviewround: 0 },
    ];
    return {
        group: { ...live.group, tasks, final: { ...live.group.final }, planreview: { state: "passed", round: 2 } },
        digest: {
            ...landed.digest,
            health: "healthy",
            counts: { ...landed.digest.counts, done: 2, running: t4 === "asks" ? 2 : 1, attention: t4 === "asks" ? 1 : 0 },
            tasks: t4 === "asks" ? [{ taskid: "t-4", waitreason: "ask", mergestate: "waiting", cleanupstate: "clear" }] : [],
        },
    };
}

// the worker's question the lead answers, raised before the board's first entry
function askEvent() {
    const [ev] = Object.values(dagActions.answered.runEvents)[0];
    return { ...ev, runid: RUN, channelid: CHANNEL, ts: T0 + S };
}

const effortNow = (extra = {}) => {
    const seeded = initiative["added-noted"].seed[`effort:${EFFORT}`];
    return { ...seeded, ...extra, chunks: seeded.chunks.map((c, i) => (i === 0 ? { ...c, status: "done" } : c)) };
};

const effortShowJson = () => {
    const before = initiative["effort-show"].seed[`effort:${EFFORT}`];
    return bash({
        description: "Show the initiative",
        command: `wsh effort show effort:${EFFORT} --json`,
        output: JSON.stringify({ effort: before }),
        ts: T0 + 2 * S,
        durationMs: 300,
    });
};

const blockedChunk4 = () =>
    wsh(`wsh effort chunk status ${EFFORT} 4 blocked --note "your call on hiding or folding it"`, 2, { description: "Block chunk 4" });

// ---- the boards ---------------------------------------------------------------------------------------------------

const boardInitiative = () =>
    chain(
        [
            take(own([user("check the initiative Rendered view: chat-renderer parity, where are we. Pick up from the newest note (11-16 10:04).", T0), effortShowJson()])),
            take(own([prose("The newest note (chunk 8) only renamed a label, so nothing is mid-flight. The first open chunk is 1: I'll fix that.", T0 + 4 * S)])),
            take(source(initiative["chunk-done"]), (e) => e.kind === "action"),
            take(own([prose("A docked ask no longer draws a permission band too. Committed aa00adc1b, scenario step added.", T0 + S)])),
            take(source(initiative["added-noted"]), (e) => e.kind === "action"),
            take(own([prose("Chunks 2 and 3 are both projection fixes with clear fork commits, so I'm handing them to one orchestrator run.", T0 + S)])),
            take(source(runs.runsStarted), calls(/runs start/)),
            take(own([prose("Chunk 1 is done and committed. The run takes chunks 2 and 3; I'll check on it when its plan review comes back.", T0 + S)])),
        ],
        { seed: { [`effort:${EFFORT}`]: effortNow() } }
    );

const boardRunLeadPlan = () => {
    const planReview = source(onDagRun(arc.planReview));
    return chain(
        [
            take(source(onDagRun(arc.runBrief)), users),
            take(own([...reads("src/calc.js", "docs/specs/arith.md", "pkg/jarvis/plan.go"), prose("The plan is four tasks in three lanes.", T0 + 20 * S)])),
            take(source(dag.planSubmitted), calls(/dag submit/)),
            take(planReview, slice(0, 2)),
            take(entriesOf(dagActions.toldAmended, calls(/dag amend/))),
            take(planReview, slice(2)),
        ],
        { ctx: LEAD }
    );
};

const boardRunLeadBuild = () =>
    chain(
        [
            take(entriesOf(arc.asks, users)),
            take(entriesOf(dagActions.answered, calls(/dag answer/))),
            take(entriesOf(dagActions.toldAmended, calls(/dag tell/))),
            take(source(dag.dagStatus), calls(/dag status/)),
            take(source(onDagRun(arc.runFinished)), users),
            take(source(dag.finalPassed), calls(/dag final/)),
            take(source(dag.runLanded), (e) => e.kind === "message" || calls(/complete/)(e)),
        ],
        {
            ctx: LEAD,
            seed: {
                [`dag:${RUN}`]: runningDag("review"),
                [`run:${RUN}`]: dag.runLanded.seed[`run:${RUN}`],
            },
            runEvents: { [RUN]: [askEvent()] },
        }
    );

const boardWorker = () =>
    chain(
        [
            take(source(onDagRun(arc.taskBrief)), users),
            take(own([tool("write", "src/subtract.js", { ts: T0 + S }), tool("write", "src/subtract.test.js", { ts: T0 + 2 * S }), wsh("npm test", 3, { description: "Run the tests" }), prose("Subtract is in src/subtract.js with four tests; the suite passes.", T0 + 40 * S)])),
            take(source(dag.taskComplete), calls(/complete/)),
            take(own([prose("The engine takes it from here: review, then merge.", T0 + S)])),
            take(source(dag.reviewPassed)),
            take(source(dag.reviewSentBack)),
        ],
        { ctx: WORKER }
    );

const boardAgents = () =>
    chain([
        take(own([user("Ask the Fable agent what it found on the off-hours rule, and tell the SIEM run's lead about the lock holder.", T0)])),
        take(source(agents.agentsList), calls(/agents list/)),
        take(source(agents.agentsCards), (e) => e.kind !== "user"),
    ]);

const boardRuns = () =>
    chain([
        take(source(runs.runsShow)),
        take(source(runs.runsAnswered), (e) => e.kind !== "user"),
    ]);

const boardLeadRecovery = () => {
    const wakes = source(arc.recovery);
    return chain(
        [
            take(wakes, slice(0, 2)),
            take(entriesOf(dagActions.recovery, calls(/dag retry/))),
            take(wakes, slice(2, 4)),
            take(own([tool("edit", "frontend/app/view/boards/boards.tsx", { ts: T0 + S }), tool("edit", "frontend/app/view/boards/boards.tsx", { ts: T0 + 2 * S }), wsh("npm test", 3, { description: "Run the tests" }), prose("Resolved: kept both toolbar buttons.", T0 + 4 * S)])),
            take(entriesOf(dagActions.recovery, calls(/dag merge/))),
            take(wakes, slice(4, 6)),
            take(entriesOf(dagActions.forwarded, calls(/dag forward/))),
            take(wakes, slice(6)),
            take(entriesOf(dagActions.recovery, calls(/dag escalate/))),
            take(own([prose("t-5 restarted, t-6 is merging, t-7 is on Opus. t-4 waits for your call on the arrow x/y.", T0 + S)])),
        ],
        { ctx: LEAD }
    );
};

const boardFinalFail = () => {
    const wakes = source(onDagRun(arc.finalFail, HELD_RUN));
    return chain(
        [
            take(wakes, slice(0, 2)),
            take(entriesOf(dag.fixRound, calls(/dag submit/))),
            take(wakes, slice(2)),
            take(source(dag.runHeld), calls(/complete/)),
            take(own([prose("The branch stays unmerged. Landing it anyway is your call, once you've read the report: wsh runs land d508bb65 --force", T0 + S)])),
        ],
        { ctx: HELD_LEAD, seed: { ...dag.fixRound.seed, ...dag.runHeld.seed } }
    );
};

const boardBrainstorm = () => {
    const judged = source(arc.judge);
    return chain(
        [
            take(judged, slice(0, 1)),
            take(entriesOf(notes.judgeStarted, calls(/brainstorm judge/))),
            take(judged, slice(1)),
            take(entriesOf(arc.panePick, users)),
            take(own([prose("Written into Approach. Last question: should a waiting verify show in the run's graph as queued?", T0 + S)])),
            take(source(arc.paneActions), slice(1)),
        ],
        { ctx: notes.judgeStarted.ctx, brainstorm: notes.judgeStarted.brainstorm }
    );
};

const boardJira = () =>
    chain([
        take(source(notes.jiraShow), (e) => e.kind !== "message"),
        take(own([wsh("wsh jira attachments SIEM-1748", 1, { description: "Save the screenshots", output: JIRA_SAVED, durationMs: 1500 }), ...reads(...JIRA_IMAGES).map((e, i) => ({ ...e, ts: T0 + (i + 2) * S, images: [{ mediaType: "image/png", data: PNG_1X1 }] })), prose("The screenshots show the chatbot restating the search results. The ticket asks for analysis on top of them, but nobody has said yet what a good answer looks like.", T0 + 6 * S)])),
        take(source(initiative.created), calls(/effort create/)),
        take(own([wsh('wsh effort chunk note siem1748 1 --note "Made from SIEM-1748: chunks from the description; its comments ask for an example"', 1, { description: "Note chunk 1" })])),
        take(source(initiative["chunk-blocked"]), (e) => e.kind !== "user"),
    ]);

const boardEffortList = () =>
    chain([
        take(own([user("which initiatives are nearly done? save the list as a note", T0)])),
        take(source(initiative["effort-list"]), (e) => e.kind !== "user"),
        take(source(notes.noteFromRecord), (e) => e.kind !== "user" && e.ts > T0 + S),
    ]);

const boardCompactLead = () =>
    chain(
        [
            take(source(onDagRun(arc.compactWakes)), slice(0, 2)),
            take(source(dagActions.compactAmended), calls(/dag amend/)),
            take(source(onDagRun(arc.planReview)), slice(3, 4)),
            take(source(dag.dagStatus), calls(/dag status/)),
            take(own([prose("All four landed after t-4's answer. Final passed on round 1.", T0 + S)])),
            take(source(dag.runLanded), calls(/complete/)),
        ],
        {
            ctx: LEAD,
            compact: true,
            width: CARD_WIDTH,
            seed: { [`dag:${RUN}`]: runningDag("asks"), [`run:${RUN}`]: dag.runLanded.seed[`run:${RUN}`] },
        }
    );

const boardCompactInitiative = () =>
    chain(
        [
            take(own([user("pick up the initiative, fix chunk 1, hand 2 and 3 to a run", T0)])),
            take(source(initiative["chunk-done"]), (e) => e.kind === "action"),
            take(source(runs.runsStarted), calls(/runs start/)),
            take(source(agents.agentsCards), calls(/agents send/)),
            take(source(notes.compactNote), calls(/note add/)),
            take(own([blockedChunk4()])),
            take(own([prose("Chunk 1 is done. The run has 2 and 3. Chunk 4 waits on you.", T0 + S)])),
        ],
        { compact: true, width: CARD_WIDTH, seed: { [`effort:${EFFORT}`]: effortNow() } }
    );

// expect.cards: wsh card keys and how many; expect.views: [step command text, view key] each opened and read;
// expect.summaries: [step command text, summary, its computed colour] read on the row while collapsed;
// expect.arc: [message kind, count]; expect.folds: at least this many Worked-for folds;
// expect.images: [the row before the group, the group's title, its image rows once opened]
const BOARDS = [
    {
        name: "Initiative",
        build: boardInitiative,
        expect: {
            folds: 1,
            views: [["wsh effort show", "effort-show"]],
            cards: { "chunk-status": 1, "chunk-add": 1, "runs-start": 1 },
        },
    },
    {
        name: "RunLeadPlan",
        build: boardRunLeadPlan,
        expect: {
            folds: 1,
            cards: { "dag-submit": 1, "dag-amend": 2 },
            arc: { brief: 1, wake: 2 },
        },
    },
    {
        name: "RunLeadBuild",
        build: boardRunLeadBuild,
        expect: {
            views: [["wsh jarvis dag status", "dag-status"]],
            cards: { "dag-answer": 1, "dag-tell": 1, "dag-final": 1, "jarvis-complete": 1 },
            arc: { wake: 2 },
        },
    },
    {
        name: "Worker",
        build: boardWorker,
        expect: {
            folds: 1,
            cards: { "jarvis-complete": 1, "dag-review": 2 },
            arc: { brief: 1 },
        },
    },
    {
        name: "Agents",
        build: boardAgents,
        expect: {
            views: [["wsh agents list", "agents-list"]],
            cards: { "agents-send": 1, "agents-read": 1, "ui-reveal": 2 },
        },
    },
    {
        name: "Runs",
        build: boardRuns,
        expect: {
            views: [
                ["wsh runs show", "runs-show"],
                ["wsh runs attention", "runs-attention"],
            ],
            summaries: [["wsh runs attention", "nothing waiting", SECONDARY_RGB]],
            cards: { "runs-answer": 1 },
        },
    },
    {
        name: "LeadRecovery",
        build: boardLeadRecovery,
        expect: {
            folds: 1,
            cards: { "dag-retry": 1, "dag-merge": 1, "dag-forward": 1, "dag-escalate": 1 },
            arc: { wake: 4 },
        },
    },
    {
        name: "FinalFail",
        build: boardFinalFail,
        expect: {
            cards: { "dag-submit": 1, "jarvis-complete": 1 },
            arc: { wake: 2 },
            waited: true,
        },
    },
    {
        name: "Brainstorm",
        build: boardBrainstorm,
        expect: {
            cards: { "brainstorm-judge": 1 },
            arc: { brainstorm: 4 },
        },
    },
    {
        name: "Jira",
        build: boardJira,
        expect: {
            folds: 1,
            views: [["wsh jira show", "jira-show"]],
            summaries: [["wsh jira attachments", "3 saved", MUTED_RGB]],
            images: ["Save the screenshots", "Read 3 images", 3],
            cards: { "effort-create": 1, "chunk-note": 1, "chunk-status": 1 },
        },
    },
    {
        name: "EffortList",
        build: boardEffortList,
        expect: {
            views: [["wsh effort list", "effort-list"]],
            cards: { "note-add": 1 },
        },
    },
    {
        name: "CompactLead",
        build: boardCompactLead,
        expect: {
            views: [["wsh jarvis dag status", "dag-status"]],
            cards: { "dag-amend": 2, "jarvis-complete": 1 },
            arc: { wake: 2 },
        },
    },
    {
        name: "CompactInitiative",
        build: boardCompactInitiative,
        expect: {
            folds: 1,
            cards: { "chunk-status": 2, "runs-start": 1, "agents-send": 1, "note-add": 1 },
        },
    },
];

// ---- reading a board ----------------------------------------------------------------------------------------------

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

// opens the step row holding `text`, opening the folds first when the row is not mounted; true once its view mounted
const openView = (text, key) =>
    probe(`
    const find = () => [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    let row = find();
    if (!row) {
        root.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click());
        return 'folded';
    }
    const btn = row.querySelector('button[aria-expanded]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return { inBox: !!row.closest('[data-steps]') };
`);

// the summary on the step row holding `text`, its colour, and whether the row is still collapsed; opens the folds
// first when the row is not mounted
const rowSummary = (text) =>
    probe(`
    const row = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    if (!row) {
        root.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click());
        return 'folded';
    }
    const summary = row.querySelector('[data-step-summary]');
    return {
        collapsed: row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'false',
        summary: summary?.textContent ?? null,
        color: summary ? getComputedStyle(summary).color : null,
    };
`);

const viewMounted = (key) => probe(`return !!root.querySelector('[data-wsh-view="${key}"]');`);

// the image-reads group row: its title, the row before it, and whether it was closed; then clicks it open. Opens the
// folds first when the group is not mounted.
const openImageGroup = () =>
    probe(`
    const groups = root.querySelectorAll('[data-step-group="images"]');
    if (!groups.length) {
        root.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click());
        return 'folded';
    }
    const group = groups[0];
    // each row of a step box sits in its own reveal wrapper, so the row before is the wrapper's sibling
    const btn = group.querySelector(':scope > button[aria-expanded]');
    const closed = btn?.getAttribute('aria-expanded') === 'false';
    const title = (btn?.innerText ?? '').replace(/\\s+/g, ' ').trim();
    if (closed) btn.click();
    return { groups: groups.length, closed, title, before: group.parentElement.previousElementSibling?.textContent ?? null };
`);

// the opened group's member rows and the image card each draws
const imageGroupMembers = () =>
    probe(`
    const group = root.querySelector('[data-step-group="images"]');
    if (!group) return null;
    const rows = [...group.querySelectorAll('[data-step]')];
    return {
        expanded: group.querySelector(':scope > button')?.getAttribute('aria-expanded'),
        rows: rows.length,
        withImage: rows.filter((r) => r.querySelector('[data-tool-card="image"] img')).length,
    };
`);

const SNAPSHOT = probe(`
    const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const cards = {};
    const cardsInBox = [];
    for (const c of root.querySelectorAll('[data-wsh-card]')) {
        const key = c.getAttribute('data-wsh-card');
        cards[key] = (cards[key] ?? 0) + 1;
        if (c.closest('[data-steps]')) cardsInBox.push(key);
    }
    const arc = {};
    const arcInBubble = [];
    for (const m of root.querySelectorAll('[data-arc-message]')) {
        const kind = m.getAttribute('data-arc-message');
        arc[kind] = (arc[kind] ?? 0) + 1;
        if (m.closest('[data-user-bubble]')) arcInBubble.push(kind);
    }
    return {
        cards,
        cardsInBox,
        arc,
        arcInBubble,
        bubbles: [...root.querySelectorAll('[data-user-bubble]')].map((b) => textOf(b).slice(0, 60)),
        folds: root.querySelectorAll('[data-fold]').length,
        waited: root.querySelectorAll('[data-waited]').length,
        fits: root.scrollWidth <= root.clientWidth + 1,
        width: Math.round(root.getBoundingClientRect().width),
    };
`);

const ARC_BUBBLE = /^(wake|brainstorm):/;

async function readBoard(h, board) {
    const fixture = board.build();
    await showFixture(h, fixture, fixture.width);
    const { expect } = board;
    const summaries = [];
    for (const [text, want, color] of expect.summaries ?? []) {
        let row = await h.ev(rowSummary(text));
        if (row === "folded") {
            await sleep(MOTION_MS);
            row = await h.ev(rowSummary(text));
        }
        summaries.push({ text, want, color, row });
    }
    const opened = [];
    for (const [text, key] of expect.views ?? []) {
        let r = await h.ev(openView(text, key));
        if (r === "folded") {
            await sleep(MOTION_MS);
            r = await h.ev(openView(text, key));
        }
        await sleep(MOTION_MS);
        opened.push({ text, key, row: r, mounted: await h.ev(viewMounted(key)) });
    }
    let images = null;
    if (expect.images) {
        let group = await h.ev(openImageGroup());
        if (group === "folded") {
            await sleep(MOTION_MS);
            group = await h.ev(openImageGroup());
        }
        await sleep(MOTION_MS);
        images = { group, members: await h.ev(imageGroupMembers()) };
    }
    const snap = await h.ev(SNAPSHOT);
    await h.shot(`${SHOT_DIR}/transcript-boards-${board.name}.png`);
    return { snap, opened, summaries, images, width: fixture.width };
}

function judgeImages([before, title, n], { group, members }) {
    if (typeof group !== "object" || group == null) return [`no image-reads group row (${JSON.stringify(group)})`];
    const faults = [];
    if (group.groups !== 1) faults.push(`${group.groups} image-reads groups, want 1`);
    if (!group.closed) faults.push("the image-reads group did not start closed");
    if (group.title !== title) faults.push(`image-reads group reads "${group.title}", want "${title}"`);
    if (!group.before?.includes(before)) faults.push(`image-reads group follows "${group.before}", want "${before}"`);
    if (members?.expanded !== "true" || members.rows !== n || members.withImage !== n) {
        faults.push(`opened image-reads group: ${JSON.stringify(members)}, want ${n} image rows`);
    }
    return faults;
}

function judgeBoard(board, { snap, opened, summaries, images, width }) {
    const { expect } = board;
    const faults = [];
    if (snap == null) return { ok: false, detail: "the transcript did not mount" };
    for (const [key, n] of Object.entries(expect.cards ?? {})) {
        if ((snap.cards[key] ?? 0) < n) faults.push(`card ${key}: ${snap.cards[key] ?? 0} of ${n}`);
    }
    if (snap.cardsInBox.length) faults.push(`cards inside a step box: ${snap.cardsInBox.join(",")}`);
    for (const o of opened) {
        if (typeof o.row !== "object" || o.row == null || !o.row.inBox) faults.push(`${o.key} is not a step row in a box`);
        if (!o.mounted) faults.push(`${o.key} did not open to its view`);
    }
    for (const s of summaries) {
        if (!s.row?.collapsed || s.row.summary !== s.want || s.row.color !== s.color) {
            faults.push(`${s.text} row summary: ${JSON.stringify(s.row)}, want ${s.want} in ${s.color}`);
        }
    }
    if (expect.images) faults.push(...judgeImages(expect.images, images));
    for (const [kind, n] of Object.entries(expect.arc ?? {})) {
        if ((snap.arc[kind] ?? 0) < n) faults.push(`arc ${kind}: ${snap.arc[kind] ?? 0} of ${n}`);
    }
    if (snap.arcInBubble.length) faults.push(`Arc messages inside a user bubble: ${snap.arcInBubble.join(",")}`);
    const lit = snap.bubbles.filter((b) => ARC_BUBBLE.test(b));
    if (lit.length) faults.push(`user bubbles that are Arc messages: ${lit.join(" | ")}`);
    if (snap.folds < (expect.folds ?? 0)) faults.push(`folds: ${snap.folds} of ${expect.folds}`);
    if (expect.waited && snap.waited < 1) faults.push("no Waited fold before the second wake");
    if (!snap.fits) faults.push("the board overflows its column");
    if (snap.width !== width) faults.push(`column is ${snap.width} px, not ${width}`);
    return { ok: faults.length === 0, detail: faults.length ? faults.join("; ") : JSON.stringify(snap) };
}

export const transcriptBoards = {
    name: "transcript-boards",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        for (const board of BOARDS) {
            const read = await readBoard(h, board);
            const { ok, detail } = judgeBoard(board, read);
            steps.push({ step: `${board.name} board: cards outside the fold, reads open to their view, Arc messages as events`, ok, detail });
        }
        return steps;
    },
    async teardown(h) {
        await transcriptNotes.teardown(h);
        await clearTranscript(h);
    },
};
