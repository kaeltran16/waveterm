// Scenario `transcript-agents`: agent-to-agent calls in a transcript (wshcards-agents.tsx): the agents list view (and its
// load error when the roster RPC refuses), the Sent to and From cards, and the ui reveal rows. A seeded roster names
// the tabs, so the cards read as names, not ids.
// Each check runs at the Rendered column's width; the cards also run at a card's (compact).

import { APP_MOD } from "./scenarios-shared.mjs";
import { bash, clearTranscript, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
// the step body's open motion settles before a step reads it
const MOTION_MS = 600;
const COLUMN = 736;
const COMPACT_COLUMN = 380;

const LEAD = {
    tabid: "90d97f06-3b1c-4e2a-9d11-0a1b2c3d4e01",
    name: "Lead · SIEM lock investigation",
    projectpath: "C:/work/siem",
    project: "siem-detector",
    runid: "eb4d4b0e-6f7a-4c1d-8e22-1b2c3d4e5f02",
    harness: "claude",
    state: "working",
};
const FABLE = {
    tabid: "298d47cf-5a6b-4c7d-8e9f-0a1b2c3d4e03",
    name: "Fable: off-hours rule audit",
    projectpath: "C:/work/siem",
    project: "siem-detector",
    runid: "",
    harness: "claude",
    state: "working",
};
const REPORT = {
    tabid: "4c1e9a20-1111-4222-8333-444455556604",
    name: "Weekly report draft",
    projectpath: "C:/work/reports",
    project: "",
    runid: "",
    harness: "claude",
    state: "asking",
};
const PARITY = {
    tabid: "70a8402d-7777-4888-8999-aaaabbbbcc05",
    name: "Rendered view parity",
    projectpath: "C:/work/arc",
    project: "arc",
    runid: "",
    harness: "pi",
    state: "idle",
};
const ROSTER = [LEAD, FABLE, REPORT, PARITY];
const SEED = { agents: { agents: ROSTER } };

const SENT_TEXT =
    "New finding from the SIEM run that changes part C: the process holding the lock is the nightly compactor, not the detector.";
const ANSWER = "I'm checking whether the off-hours rule reads hours in UTC or local time. If it's UTC, the remaining alarms may be a timezone bug.";
const SCRATCH = "scratch/prod-inv/prod_inv.sh";
const JOINED = "joined its running turn";
const UNKNOWN_TAB ="ffff1111-0000-4000-8000-000000000099";

const LIST = 'wsh agents list';
const LIST_JSON = "wsh agents list --json";

// each fixture is { entries, seed } for the boards scenario to compose
export const fixtures = {
    agentsList: {
        entries: [
            user("Which agents are live?", T0),
            bash({ description: "List live agents", command: LIST, output: "90d97f06  Lead  siem-detector  eb4d4b0e  claude  working", ts: T0 + S, durationMs: 200 }),
            prose("Four are live.", T0 + 2 * S),
        ],
        seed: SEED,
    },
    // no seed and no --json output: the view reads the live roster, which the step refuses
    agentsListNotLoaded: {
        entries: [
            user("Which agents are live?", T0),
            bash({ description: "List live agents", command: LIST, output: "90d97f06  Lead  siem-detector  eb4d4b0e  claude  working", ts: T0 + S, durationMs: 200 }),
            prose("I could not read the roster.", T0 + 2 * S),
        ],
    },
    agentsListJson: {
        entries: [
            user("Which agents are live?", T0),
            bash({ description: "List live agents", command: LIST_JSON, output: JSON.stringify([REPORT, PARITY]), ts: T0 + S, durationMs: 200 }),
            prose("Two are live.", T0 + 2 * S),
        ],
        seed: SEED,
    },
    agentsCards: {
        entries: [
            user("Tell the SIEM lead about the lock holder, then ask the Fable agent what it found.", T0),
            bash({
                description: "Send to the lead",
                command: `wsh agents send ${LEAD.tabid} "${SENT_TEXT}"`,
                output: "sent to 90d97f06: it joined the turn the agent is running",
                ts: T0 + S,
                durationMs: 600,
            }),
            prose("Sent. Now the Fable agent: reading its last answer.", T0 + 2 * S),
            bash({ description: "Read the Fable agent", command: `wsh agents read ${FABLE.tabid}`, output: ANSWER, ts: T0 + 3 * S, durationMs: 300 }),
            bash({ description: "Show the agent", command: `wsh ui reveal agent:${FABLE.tabid}`, output: "", ts: T0 + 4 * S, durationMs: 120 }),
            bash({ description: "Open the script", command: `wsh ui reveal ${SCRATCH}`, output: "", ts: T0 + 5 * S, durationMs: 110 }),
            prose("The lead has the lock finding.", T0 + 6 * S),
        ],
        seed: SEED,
    },
    // --json prints the RPC return, the one output the card parses midturn from
    agentsSendJson: {
        entries: [
            user("Tell the lead.", T0),
            bash({
                description: "Send to the lead",
                command: `wsh agents send ${LEAD.tabid} "${SENT_TEXT}" --json`,
                output: JSON.stringify({ tabid: LEAD.tabid, sentts: T0 + S, midturn: true }),
                ts: T0 + S,
                durationMs: 600,
            }),
            prose("Sent.", T0 + 2 * S),
        ],
        seed: SEED,
    },
    // a tab the roster does not know: the card still draws from argv
    agentsSendUnknown: {
        entries: [
            user("Tell the old agent.", T0),
            bash({ description: "Send", command: `wsh agents send ${UNKNOWN_TAB} "are you there"`, output: "sent", ts: T0 + S, durationMs: 90 }),
            prose("Sent.", T0 + 2 * S),
        ],
        seed: SEED,
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const LIST_STATE = probe(`
    const view = root.querySelector('[data-wsh-view="agents-list"]');
    if (!view) return null;
    return {
        rows: [...view.querySelectorAll('[data-agent-row]')].map((r) => r.textContent),
        asOfNow: view.textContent.includes('as of now'),
        dots: view.querySelectorAll('[data-agent-row] > span:first-child').length,
    };
`);

const CARDS_STATE = probe(`
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const col = root.getBoundingClientRect();
    const send = root.querySelector('[data-wsh-card="agents-send"]');
    const read = root.querySelector('[data-wsh-card="agents-read"]');
    const reveals = [...root.querySelectorAll('[data-wsh-card="ui-reveal"]')];
    return {
        colWidth: col.width,
        overflow: root.scrollWidth > root.clientWidth,
        send: send ? { text: send.textContent, rect: rect(send.firstElementChild), inFold: !!send.closest('[data-steps]'), button: !!send.querySelector('button[aria-label="Show the command"]'), duration: /\\d(ms|s)/.test(send.textContent) } : null,
        read: read ? { text: read.textContent, rect: rect(read.firstElementChild), openAgent: !![...read.querySelectorAll('button')].find((b) => b.textContent.includes('Open agent')), button: !!read.querySelector('button[aria-label="Show the command"]') } : null,
        reveals: reveals.map((r) => ({ text: r.textContent, button: !!r.querySelector('button[aria-label="Show the command"]') })),
    };
`);

const clickFirstStep = `document.querySelector(${JSON.stringify(ROOT)}).querySelector('[data-step] button')?.click()`;

// the roster's wshdata key (wshcards-agents.tsx ROSTER_KEY)
const ROSTER_KEY = "agents";
const ROSTER_REFUSED = "refused on the page: AgentsListCommand";

const refuseRosterExpr = (refuse) => `(async () => {
    ${APP_MOD}
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    window.__agentsRpcOrig ??= RpcApi.AgentsListCommand;
    RpcApi.AgentsListCommand = ${refuse} ? async () => { throw new Error(${JSON.stringify(ROSTER_REFUSED)}); } : window.__agentsRpcOrig;
    return true;
})()`;

const ROSTER_STATUS = `(async () => {
    ${APP_MOD}
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { wshDataAtom } = await mod("app/view/agents/wshdata.ts");
    return globalStore.get(wshDataAtom(${JSON.stringify(ROSTER_KEY)})).status;
})()`;

const LIST_VIEW_TEXT = probe(`
    const view = root.querySelector('[data-wsh-view="agents-list"]');
    return view ? view.textContent : null;
`);

// must run before anything seeds or loads the roster key: a seeded key never fetches, and a loaded one keeps its data
// through a failed refetch, so the error would never show
async function rosterErrorStep(h) {
    const before = await h.ev(ROSTER_STATUS);
    await h.ev(refuseRosterExpr(true));
    try {
        await showTranscript(h, { ...fixtures.agentsListNotLoaded, width: COLUMN, active: false });
        await h.ev(clickFirstStep);
        await sleep(MOTION_MS);
        const text = await h.ev(LIST_VIEW_TEXT);
        await h.shot("cdp-shots/transcript-agents-list-not-loaded.png");
        return {
            step: "agents list without --json, the roster RPC refused: the opened step shows its inline load error",
            ok: before === "idle" && text != null && text.includes("Could not load the agent list") && text.includes(ROSTER_REFUSED),
            detail:
                before === "idle"
                    ? JSON.stringify({ text })
                    : `the roster key "${ROSTER_KEY}" was already ${before} before this step (an earlier scenario seeded or loaded it), so no fetch could fail: ${JSON.stringify({ text })}`,
        };
    } finally {
        await h.ev(refuseRosterExpr(false));
    }
}

async function listSteps(h) {
    const steps = [];
    await showTranscript(h, { ...fixtures.agentsList, width: COLUMN, active: false });
    await h.ev(clickFirstStep);
    await sleep(MOTION_MS);
    const list = await h.ev(LIST_STATE);
    await h.shot("cdp-shots/transcript-agents-list.png");
    steps.push({
        step: "agents list opened: one row per agent with its state dot, name, run or project or state, and short id, marked as of now",
        ok:
            list != null &&
            list.rows.length === ROSTER.length &&
            list.dots === ROSTER.length &&
            list.rows[0].includes(LEAD.name) &&
            list.rows[0].includes("run eb4d4b0e") &&
            list.rows[0].includes("90d97f06") &&
            list.rows[1].includes("siem-detector") &&
            list.rows[2].includes("asking") &&
            list.rows[3].includes("arc") &&
            list.asOfNow === true,
        detail: JSON.stringify(list),
    });

    await showTranscript(h, { ...fixtures.agentsListJson, width: COLUMN, active: false });
    await h.ev(clickFirstStep);
    await sleep(MOTION_MS);
    const printed = await h.ev(LIST_STATE);
    steps.push({
        step: "agents list --json draws the call's own rows, not the roster, and is not marked as of now",
        ok: printed != null && printed.rows.length === 2 && printed.rows[0].includes(REPORT.name) && printed.asOfNow === false,
        detail: JSON.stringify(printed),
    });
    return steps;
}

async function cardSteps(h, width, compact) {
    const tag = compact ? `[${width} compact]` : `[${width}]`;
    const steps = [];
    await showTranscript(h, { ...fixtures.agentsCards, width, compact, active: false });
    const s = await h.ev(CARDS_STATE);
    await h.shot(`cdp-shots/transcript-agents-cards-${width}.png`);
    const ratio = (c) => (c ? c.rect.width / s.colWidth : 0);

    steps.push({
        step: `${tag} Sent to with its text: the target's name, the text, outside the fold, with the call's duration and Show the command`,
        ok:
            s?.send != null &&
            s.send.text.includes("Sent to") &&
            s.send.text.includes(LEAD.name) &&
            s.send.text.includes(SENT_TEXT) &&
            s.send.inFold === false &&
            !s.send.text.includes(JOINED) &&
            s.send.button === true &&
            s.send.duration === true &&
            ratio(s.send) > 0.7 &&
            ratio(s.send) < 0.95 &&
            s.overflow === false,
        detail: JSON.stringify(s?.send),
    });
    steps.push({
        step: `${tag} From with Open agent: the agent's name and its answer`,
        ok:
            s?.read != null &&
            s.read.text.includes("From") &&
            s.read.text.includes(FABLE.name) &&
            s.read.text.includes(ANSWER) &&
            s.read.openAgent === true &&
            s.read.button === true,
        detail: JSON.stringify(s?.read),
    });

    await showTranscript(h, { ...fixtures.agentsSendJson, width, compact, active: false });
    const json = await h.ev(CARDS_STATE);
    steps.push({
        step: `${tag} agents send --json with midturn: Sent to reads "${JOINED}" (plain output above does not)`,
        ok: json?.send != null && json.send.text.includes("Sent to") && json.send.text.includes(LEAD.name) && json.send.text.includes(JOINED),
        detail: JSON.stringify(json?.send),
    });
    if (compact) return steps;

    steps.push({
        step: `${tag} Showed in Arc and Opened in Arc rows: an agent by name, a file by path`,
        ok:
            s?.reveals.length === 2 &&
            s.reveals[0].text.includes("Showed in Arc") &&
            s.reveals[0].text.includes(FABLE.name) &&
            s.reveals[1].text.includes("Opened in Arc") &&
            s.reveals[1].text.includes(SCRATCH) &&
            s.reveals.every((r) => r.button),
        detail: JSON.stringify(s?.reveals),
    });

    await showTranscript(h, { ...fixtures.agentsSendUnknown, width, compact, active: false });
    const unknown = await h.ev(CARDS_STATE);
    steps.push({
        step: `${tag} a tab the roster lacks: Sent to reads the short id, with its text`,
        ok: unknown?.send != null && unknown.send.text.includes("ffff1111") && unknown.send.text.includes("are you there"),
        detail: JSON.stringify(unknown?.send),
    });
    return steps;
}

export const transcriptAgents = {
    name: "transcript-agents",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        steps.push(await rosterErrorStep(h));
        steps.push(...(await listSteps(h)));
        steps.push(...(await cardSteps(h, COLUMN, false)));
        steps.push(...(await cardSteps(h, COMPACT_COLUMN, true)));
        return steps;
    },
    async teardown(h) {
        await h.ev(refuseRosterExpr(false));
        await clearTranscript(h);
    },
};
