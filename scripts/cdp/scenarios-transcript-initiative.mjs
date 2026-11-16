// Scenario `transcript-initiative`: wsh effort cards and views in a transcript (wshcards-initiative.tsx). The effort
// show and list calls open to a structured view; chunk and initiative changes draw as cards inside their turn's fold,
// never inside a step box. The
// effort data is seeded into the wshdata cache, so no initiative is created or changed in the live app.

import { bash, clearTranscript, openFolds, prose, ROOT, showTranscript, tool, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
// the step body's reveal motion settles before a step reads it
const MOTION_MS = 600;
// an unseeded effort id goes to the live RPC; its rejection lands within this
const LOAD_POLLS = 20;
const LOAD_POLL_MS = 400;

const EID = "f283ad11";
const TITLE = "Rendered view: chat-renderer parity";
const LABELS = [
    "Fix: AskUserQuestion shows a duplicate permission band",
    "Projection: a model Skill call reads as an action",
    "Projection: a refused Bash reads Blocked, not failed",
    "Decide: show thinking-only narration, and how",
    "Subagent rows in the Rendered view",
    "Sessions detail transcript",
    "Ended transcripts",
    "Slash command panel in the Rendered box",
];
const CHUNK_TOTAL = 18;
const SHOW_SHOWN = 5;
const LIST_TOTAL = 20;
const LIST_SHOWN = 7;

const chunk = (label, status, notes = 0) => ({
    label,
    status,
    notes: Array.from({ length: notes }, (_, i) => ({ ts: T0 + i, text: `note ${i + 1}` })),
    updatedts: T0,
});

// an effort record as EffortGetCommand returns it
function effort({ oid, title, project, ticket, chunks, events = [] }) {
    return { otype: "effort", oid, version: 1, title, project, ticket, status: "active", chunks, events, createdts: T0, updatedts: T0 };
}

const renderParity = (extra = 0, firstStatus = "done") =>
    effort({
        oid: EID,
        title: TITLE,
        project: "waveterm",
        chunks: [
            ...Array.from({ length: CHUNK_TOTAL }, (_, i) => chunk(LABELS[i] ?? `Chunk ${i + 1}`, i === 0 ? firstStatus : "pending", i < 4 ? 1 : 0)),
            ...Array.from({ length: extra }, (_, i) => chunk(i === 0 ? "Decide: does the Sessions detail keep the dense rows" : `Extra ${i}`, "pending")),
        ],
        events: [{ ts: T0 + 10 * S, kind: "chunk-done", label: LABELS[0] }],
    });

const summary = (i, extra = {}) => ({
    oref: `effort:s${i}`,
    title: `Initiative ${i}`,
    status: "active",
    done: i,
    total: 20,
    updatedts: T0 - i,
    activechunk: `Current chunk of ${i}`,
    ...extra,
});

const SIEM_CHUNKS = [
    "Decide: what analysis of a log search should return",
    "Summarize a search: counts, top sources, time spread",
    "Point out what stands out against the tenant's usual traffic",
    "Verify on .236 with the three screenshots' searches",
];
const SIEM = effort({
    oid: "siem1748",
    title: "AI Chatbot improvements",
    project: "cyber_assistant",
    ticket: "SIEM-1748",
    chunks: SIEM_CHUNKS.map((l) => chunk(l, "pending")),
});
const SIEM_SUMMARY = {
    oref: "effort:siem1748",
    title: "AI Chatbot improvements",
    project: "cyber_assistant",
    ticket: "SIEM-1748",
    status: "active",
    done: 0,
    total: SIEM_CHUNKS.length,
    updatedts: T0,
    chunks: SIEM_CHUNKS.map((label) => ({ label, status: "pending" })),
};

// an effort only the call's own --json output carries: nothing seeds it, so the view can only draw from that output
const JSON_EID = "j50n0001";
const JSON_TITLE = "Effort drawn from its own output";
const JSON_CHUNKS = ["First chunk", "Second chunk", "Third chunk"];
const JSON_EFFORT = effort({
    oid: JSON_EID,
    title: JSON_TITLE,
    project: "waveterm",
    chunks: JSON_CHUNKS.map((l, i) => chunk(l, i === 0 ? "done" : "pending")),
});

const cmd = (rest) => `wsh effort ${rest}`;

// the named inputs the boards scenario composes: { entries, seed?, runEvents?, ctx? }
export const fixtures = {
    "effort-show": {
        entries: [
            user("check the initiative, where are we", T0),
            bash({ description: "Show the initiative", command: cmd(`show effort:${EID}`), output: `${TITLE}\n 0/18 done`, ts: T0 + 2 * S, durationMs: 300 }),
            prose("Nothing is mid-flight; chunk 1 is first.", T0 + 4 * S),
        ],
        seed: { [`effort:${EID}`]: renderParity(0, "pending") },
    },
    "effort-show-json": {
        entries: [
            user("show that initiative as JSON", T0),
            bash({
                description: "Show the initiative",
                command: cmd(`show effort:${JSON_EID} --json`),
                output: JSON.stringify({ effort: JSON_EFFORT }),
                ts: T0 + 2 * S,
                durationMs: 300,
            }),
            prose("One of three is done.", T0 + 4 * S),
        ],
    },
    "effort-list": {
        entries: [
            user("which initiatives are nearly done?", T0),
            bash({ description: "List initiatives", command: cmd("list"), output: "s1 Initiative 1", ts: T0 + 2 * S, durationMs: 400 }),
            prose("Four are close.", T0 + 4 * S),
        ],
        seed: {
            efforts: Array.from({ length: LIST_TOTAL }, (_, i) => summary(i + 1, i === 0 ? { ticket: "SIEM-1748" } : {})),
        },
    },
    "chunk-done": {
        entries: [
            user("pick up the initiative and fix chunk 1", T0),
            tool("read", "transcriptprojection.ts", { ts: T0 + 1 * S }),
            tool("read", "narrationtimeline.tsx", { ts: T0 + 2 * S }),
            tool("read", "agentsviewmodel.ts", { ts: T0 + 3 * S }),
            bash({
                description: "Tick chunk 1",
                command: cmd(`chunk status effort:${EID} 1 done --note "A docked ask no longer draws a permission band too."`),
                output: "ok",
                ts: T0 + 20 * S,
                durationMs: 250,
            }),
            prose("Chunk 1 is done and committed.", T0 + 22 * S),
        ],
        seed: { [`effort:${EID}`]: renderParity() },
    },
    "added-noted": {
        entries: [
            user("add the Sessions detail question and note chunk 8", T0),
            bash({ description: "Add a chunk", command: cmd(`chunk add ${EID} "Decide: does the Sessions detail keep the dense rows"`), output: "ok", ts: T0 + 2 * S, durationMs: 200 }),
            bash({ description: "Note chunk 8", command: cmd(`chunk note ${EID} 8 --note "Only renamed a label; nothing mid-flight."`), output: "ok", ts: T0 + 4 * S, durationMs: 180 }),
            prose("Both are on the initiative.", T0 + 6 * S),
        ],
        seed: { [`effort:${EID}`]: renderParity(1, "pending") },
    },
    "created": {
        entries: [
            user("make an initiative from SIEM-1748", T0),
            bash({
                description: "Create the initiative",
                command: cmd(`create "AI Chatbot improvements" --project cyber_assistant --ticket SIEM-1748 ${SIEM_CHUNKS.map((c) => `--chunk "${c}"`).join(" ")}`),
                output: "created effort siem1748",
                ts: T0 + 2 * S,
                durationMs: 600,
            }),
            prose("The initiative is up with 4 chunks.", T0 + 4 * S),
        ],
        seed: { efforts: [SIEM_SUMMARY], "effort:siem1748": SIEM },
    },
    "chunk-blocked": {
        entries: [
            user("block chunk 1 until David sends the example", T0),
            bash({
                description: "Block chunk 1",
                command: cmd(`chunk status siem1748 1 blocked --note "an example from David of the answer he expects for one of the three searches"`),
                output: "ok",
                ts: T0 + 2 * S,
                durationMs: 220,
            }),
            prose("Chunk 1 waits on David.", T0 + 4 * S),
        ],
        seed: { "effort:siem1748": SIEM },
    },
    "var-resolved": {
        entries: [
            user("tick chunk 1 through a variable", T0),
            bash({
                description: "Tick chunk 1",
                command: `E=${EID} && ${cmd('chunk status $E 1 done --note "id came from a variable"')}`,
                output: "ok",
                ts: T0 + 2 * S,
                durationMs: 250,
            }),
            prose("Chunk 1 is done.", T0 + 4 * S),
        ],
        seed: { [`effort:${EID}`]: renderParity() },
    },
    "var-unresolved": {
        entries: [
            user("tick chunk 1, the id is set elsewhere", T0),
            bash({
                description: "Tick chunk 1",
                command: cmd('chunk status $E 1 done --note "id came from a variable"'),
                output: "ok",
                ts: T0 + 2 * S,
                durationMs: 250,
            }),
            prose("Chunk 1 is done.", T0 + 4 * S),
        ],
    },
    "unknown-effort": {
        entries: [
            user("tick chunk 3 on the old initiative", T0),
            bash({ description: "Tick chunk 3", command: cmd('chunk status e-does-not-exist 3 done --note "finished"'), output: "ok", ts: T0 + 2 * S, durationMs: 200 }),
            prose("Done.", T0 + 4 * S),
        ],
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const clickFirstStep = `document.querySelector(${JSON.stringify(ROOT)}).querySelector('[data-step] button')?.click()`;

const VIEW = (key) =>
    probe(`
    const v = root.querySelector('[data-wsh-view="${key}"]');
    if (!v) return null;
    const rows = [...v.querySelectorAll('[data-view-row]')].map((r) => r.textContent);
    const more = [...v.querySelectorAll('button')].map((b) => b.textContent).find((t) => /more/.test(t)) ?? null;
    return { text: v.textContent, rows, more, asOfNow: v.textContent.includes('as of now') };
`);

const CARD = (key) =>
    probe(`
    const cards = [...root.querySelectorAll('[data-wsh-card="${key}"]')];
    return cards.map((c) => ({
        text: c.textContent,
        inBox: !!c.closest('[data-steps]'),
        inFold: !!c.closest('[data-turn-fold]'),
        showCommand: !!c.querySelector('button[aria-label="Show the command"]'),
        open: [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Open'),
        overflow: c.scrollWidth > c.clientWidth + 1,
    }));
`);

async function openStep(h) {
    await h.ev(clickFirstStep);
    await sleep(MOTION_MS);
}

// every fixture is a finished turn, so its steps and cards sit behind the turn's fold
async function show(h, name, width, extra = {}) {
    await showTranscript(h, { width, ...fixtures[name], ...extra });
    await openFolds(h);
}

async function steps736(h) {
    const out = [];

    await show(h, "effort-show", 736);
    await openStep(h);
    const shown = await h.ev(VIEW("effort-show"));
    await h.shot("cdp-shots/transcript-initiative-show.png");
    const restLabel = `${CHUNK_TOTAL - SHOW_SHOWN} more chunks`;
    await h.ev(probe(`[...root.querySelectorAll('[data-wsh-view="effort-show"] button')].find((b) => /more chunks/.test(b.textContent))?.click()`));
    await sleep(MOTION_MS);
    const expanded = await h.ev(VIEW("effort-show"));
    out.push({
        step: `effort show opened as a chunk list with ${CHUNK_TOTAL - SHOW_SHOWN} more: header, first ${SHOW_SHOWN} chunks, "${restLabel}" expanding the rest`,
        ok:
            shown != null &&
            shown.text.includes(TITLE) &&
            shown.text.includes(`0 of ${CHUNK_TOTAL} done`) &&
            shown.rows.length === SHOW_SHOWN &&
            shown.rows[0].includes(LABELS[0]) &&
            shown.rows[0].includes("1 note") &&
            shown.more === restLabel &&
            shown.asOfNow === true &&
            expanded?.rows.length === CHUNK_TOTAL &&
            expanded.more === null,
        detail: JSON.stringify({ shown, expandedRows: expanded?.rows.length }),
    });

    await show(h, "effort-list", 736);
    await openStep(h);
    const list = await h.ev(VIEW("effort-list"));
    await h.shot("cdp-shots/transcript-initiative-list.png");
    out.push({
        step: "effort list as a progress table: title, ticket, done/total, current chunk, then N more initiatives",
        ok:
            list != null &&
            list.rows.length === LIST_SHOWN &&
            list.rows[0].includes("Initiative 1") &&
            list.rows[0].includes("SIEM-1748") &&
            list.rows[0].includes("1/20") &&
            list.rows[0].includes("Current chunk of 1") &&
            list.more === `${LIST_TOTAL - LIST_SHOWN} more initiatives`,
        detail: JSON.stringify(list),
    });

    await show(h, "chunk-done", 736);
    const folded = await h.ev(probe(`return root.querySelector('[data-fold]')?.textContent ?? null;`));
    const done = await h.ev(CARD("chunk-status"));
    await h.shot("cdp-shots/transcript-initiative-chunk-done.png");
    out.push({
        step: "Chunk done card inside its turn's fold, outside any step box, with progress, the note, its duration and the command one click away",
        ok:
            folded != null &&
            folded.startsWith("Worked") &&
            done?.length === 1 &&
            done[0].inFold === true &&
            done[0].inBox === false &&
            done[0].text.includes("Chunk done") &&
            done[0].text.includes(`1. ${LABELS[0]}`) &&
            done[0].text.includes("A docked ask no longer draws a permission band too.") &&
            done[0].text.includes(`1 of ${CHUNK_TOTAL} done`) &&
            done[0].text.includes("0.3s") &&
            done[0].showCommand === true &&
            done[0].open === true,
        detail: JSON.stringify({ folded, done }),
    });

    await show(h, "added-noted", 736);
    const added = await h.ev(CARD("chunk-add"));
    const noted = await h.ev(CARD("chunk-note"));
    await h.shot("cdp-shots/transcript-initiative-added-noted.png");
    out.push({
        step: "Added chunk and Noted on chunk rows: the chunk and its initiative, the chunk and its note",
        ok:
            added?.length === 1 &&
            added[0].text.includes("Added chunk") &&
            added[0].text.includes(`${CHUNK_TOTAL + 1}. Decide: does the Sessions detail keep the dense rows`) &&
            added[0].text.includes(TITLE) &&
            noted?.length === 1 &&
            noted[0].text.includes("Noted on chunk 8") &&
            noted[0].text.includes("Only renamed a label; nothing mid-flight.") &&
            noted[0].showCommand === true,
        detail: JSON.stringify({ added, noted }),
    });

    await show(h, "created", 736);
    const created = await h.ev(CARD("effort-create"));
    await h.shot("cdp-shots/transcript-initiative-created.png");
    out.push({
        step: "Initiative created with its chunks: title, ticket, the chunk rows and 0 of 4 done",
        ok:
            created?.length === 1 &&
            created[0].text.includes("Initiative created") &&
            created[0].text.includes("AI Chatbot improvements") &&
            created[0].text.includes("SIEM-1748") &&
            SIEM_CHUNKS.every((c) => created[0].text.includes(c)) &&
            created[0].text.includes(`0 of ${SIEM_CHUNKS.length} done`) &&
            created[0].open === true,
        detail: JSON.stringify(created),
    });

    await show(h, "chunk-blocked", 736);
    const blocked = await h.ev(CARD("chunk-status"));
    await h.shot("cdp-shots/transcript-initiative-blocked.png");
    out.push({
        step: "Chunk blocked with needs: the warning card, the note as needs, and where it shows",
        ok:
            blocked?.length === 1 &&
            blocked[0].text.includes("Chunk blocked") &&
            blocked[0].text.includes(`1. ${SIEM_CHUNKS[0]}`) &&
            blocked[0].text.includes("needs: an example from David") &&
            blocked[0].text.includes("Shows in the briefing's attention banner until it moves"),
        detail: JSON.stringify(blocked),
    });
    return out;
}

async function stepsCompact(h) {
    const out = [];
    const WIDTH = 380;
    await show(h, "chunk-done", WIDTH, { compact: true });
    const done = await h.ev(CARD("chunk-status"));
    const fits = await h.ev(probe(`return root.scrollWidth <= root.clientWidth + 1;`));
    await h.shot("cdp-shots/transcript-initiative-compact-done.png");
    await show(h, "chunk-blocked", WIDTH, { compact: true });
    const blocked = await h.ev(CARD("chunk-status"));
    const blockedFits = await h.ev(probe(`return root.scrollWidth <= root.clientWidth + 1;`));
    await h.shot("cdp-shots/transcript-initiative-compact-blocked.png");
    out.push({
        step: `compact Chunk done and Chunk blocked at ${WIDTH} px: both fit, the blocked card drops the banner line`,
        ok:
            fits === true &&
            blockedFits === true &&
            done?.length === 1 &&
            done[0].text.includes("Chunk done") &&
            done[0].text.includes(`1 of ${CHUNK_TOTAL} done`) &&
            done[0].overflow === false &&
            blocked?.length === 1 &&
            blocked[0].text.includes("needs: an example from David") &&
            !blocked[0].text.includes("attention banner") &&
            blocked[0].overflow === false,
        detail: JSON.stringify({ done, blocked, fits, blockedFits }),
    });
    return out;
}

async function stepShowJson(h) {
    await show(h, "effort-show-json", 736);
    await openStep(h);
    const view = await h.ev(VIEW("effort-show"));
    await h.shot("cdp-shots/transcript-initiative-show-json.png");
    return [
        {
            step: "effort show --json of an unseeded effort draws the view from its own output, with no as-of-now marker",
            ok:
                view != null &&
                view.text.includes(JSON_TITLE) &&
                view.text.includes(`1 of ${JSON_CHUNKS.length} done`) &&
                view.rows.length === JSON_CHUNKS.length &&
                view.rows[0].includes(JSON_CHUNKS[0]) &&
                view.asOfNow === false,
            detail: JSON.stringify(view),
        },
    ];
}

// the fixture host is a dialog too, so the tool detail modal is the dialog that does not hold the fixture root
const TOOL_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].filter((d) => !d.querySelector(${JSON.stringify(ROOT)})).pop()`;
const DIALOG = `(${TOOL_DIALOG})?.textContent ?? null`;

async function pollDialog(h, done) {
    let text = null;
    for (let i = 0; i < LOAD_POLLS; i++) {
        text = await h.ev(DIALOG);
        if (done(text)) break;
        await sleep(LOAD_POLL_MS);
    }
    return text;
}

async function stepShowCommand(h) {
    await show(h, "chunk-done", 736);
    const command = fixtures["chunk-done"].entries.find((e) => e.command)?.command;
    await h.ev(probe(`root.querySelector('[data-wsh-card="chunk-status"] button[aria-label="Show the command"]')?.click(); return true;`));
    const opened = await pollDialog(h, (t) => t?.includes(command));
    await h.shot("cdp-shots/transcript-initiative-show-command.png");
    // Escape where focus is, so ModalShell's window listener sees it the way a keypress would reach it
    await h.ev(`(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    )`);
    const after = await pollDialog(h, (t) => t == null);
    const hostKept = await h.ev(probe(`return true;`));
    return [
        {
            step: `a card's "Show the command" opens the tool detail modal with the call's command, and Escape closes it alone`,
            ok: opened != null && opened.includes(command) && after == null && hostKept === true,
            detail: JSON.stringify({ opened: opened?.slice(0, 200) ?? null, closed: after == null, hostKept }),
        },
    ];
}

async function stepUnknown(h) {
    await show(h, "unknown-effort", 736);
    let card = null;
    for (let i = 0; i < LOAD_POLLS; i++) {
        card = (await h.ev(CARD("chunk-status")))?.[0] ?? null;
        if (card?.text.includes("load the initiative")) break;
        await sleep(LOAD_POLL_MS);
    }
    await h.shot("cdp-shots/transcript-initiative-unknown.png");
    return [
        {
            step: "an unknown effort id still draws the Chunk done card with the load error",
            ok:
                card != null &&
                card.text.includes("Chunk done") &&
                card.text.includes("#3") &&
                card.text.includes("finished") &&
                card.text.includes("load the initiative"),
            detail: JSON.stringify(card),
        },
    ];
}

async function stepShellVariable(h) {
    await show(h, "var-resolved", 736);
    const resolved = await h.ev(CARD("chunk-status"));
    await h.shot("cdp-shots/transcript-initiative-var-resolved.png");
    await show(h, "var-unresolved", 736);
    // an unresolved id never fetches; a wrongly keyed card would already be in the DOM
    await sleep(MOTION_MS);
    const card = await h.ev(CARD("chunk-status"));
    const generic = await h.ev(probe(`
        const rows = [...root.querySelectorAll('[data-wsh-change="effort chunk status"]')];
        return { rows: rows.length, text: rows.map((r) => r.textContent), rootText: root.textContent };
    `));
    await h.shot("cdp-shots/transcript-initiative-var-unresolved.png");
    return [
        {
            step: "a resolved $E call draws the initiative card for that id; an unresolved one draws the generic change row with no load error",
            ok:
                resolved?.length === 1 &&
                resolved[0].text.includes("Chunk done") &&
                resolved[0].text.includes(`1. ${LABELS[0]}`) &&
                !resolved[0].text.includes("Couldn't load") &&
                card?.length === 0 &&
                generic?.rows === 1 &&
                generic.text[0].includes("wsh effort chunk status") &&
                !generic.rootText.includes("Couldn't load"),
            detail: JSON.stringify({ resolved, card, generic: generic && { rows: generic.rows, text: generic.text } }),
        },
    ];
}

export const transcriptInitiative = {
    name: "transcript-initiative",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        steps.push(...(await steps736(h)));
        steps.push(...(await stepsCompact(h)));
        steps.push(...(await stepShowJson(h)));
        steps.push(...(await stepShowCommand(h)));
        steps.push(...(await stepUnknown(h)));
        steps.push(...(await stepShellVariable(h)));
        return steps;
    },
    async teardown(h) {
        // a failed Escape step must not leave the modal over the next scenario
        await h.ev(`(${TOOL_DIALOG})?.querySelector('button[aria-label="Close"]')?.click()`);
        await clearTranscript(h);
    },
};
