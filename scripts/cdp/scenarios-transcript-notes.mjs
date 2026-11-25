// Scenario `transcript-notes`: the note card, the Jira show view and the brainstorm judge card (wshcards-notes.tsx): a
// note with its bullets from the note's record and from argv, a note that did not load, jira show opened as a ticket
// card (and one that did not load), the judge weighing and done, and the note as a row at 380 px.

import { restoreRoster, setRoster } from "./agent-page-fixtures.mjs";
import { APP_MOD } from "./scenarios-shared.mjs";
import { bash, clearTranscript, openFolds, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const WIDE = 736;
const NARROW = 380;
// a step's body opens with the composer's reveal
const MOTION_MS = 700;
const JUDGE_AGENT = "agent-judge-fixture";
// the brainstorm poller detaches an attached agent missing from a non-empty roster, so the judge agent joins it
const JUDGE_ROSTER = [{ id: JUDGE_AGENT, name: "judge fixture", task: "judge fixture", state: "idle", agent: "claude", project: "judge-fixture" }];
// brainstormExpr attaches the agent's brainstorm from this cwd and topic, so the store's path is under it
const JUDGE_CWD = "C:/judge-fixture";
const JUDGE_TOPIC = "judge-fixture";
// the store's path in the tab meta's form (backslashes, other case): the same file
const JUDGE_FILE_SAME = `C:\\Judge-Fixture\\.superpowers\\brainstorm\\${JUDGE_TOPIC}\\brainstorm.json`;
const JUDGE_FILE_OTHER = `C:/other-fixture/.superpowers/brainstorm/${JUDGE_TOPIC}/brainstorm.json`;
// the judge was started this long before the scenario reads it
const JUDGE_AGE_MS = 100 * S;
// stands for the time the judge call started, filled in when the fixture is shown
const JUDGE_TS = "now-judge-age";

const NOTE_TITLE = "Initiatives close to done, 11-16";
const NOTE_BODY = [
    "- **Motion sweep follow-ups**, 6/7: only the flake watch is left",
    "- **Chatbot reads CE alerts**, 4/5, and **AI Chatbot improvements**, 12/14: one .236 visit closes both",
    "- **Performance candidates**, 11/13: needs the baseline measure first",
].join("\n");

const DESCRIPTION =
    "I think the AI Chatbot can tried to provide some kind of analysis based on the logs that user has search. Currently I think the Chatbot is more likely just to elaborate all the data and present to the users only. When the user would like to know more details / asking Chatbot to tried to do some analysis, the Chatbot will just return similar results.";
const TICKET = {
    ticket: {
        key: "SIEM-1748",
        summary: "AI Chatbot improvements",
        type: "Enhancement",
        status: "New",
        statuscategory: "new",
        description: DESCRIPTION,
        url: "https://jira.example/browse/SIEM-1748",
        attachments: ["030246", "030558", "030615"].map((t, i) => ({
            id: String(10 + i),
            filename: `image-20261109-${t}.png`,
            mimetype: "image/png",
            size: 1024,
        })),
        comments: [
            { id: "c1", author: "Khang Tran", createdts: Date.UTC(2026, 10, 9, 12), body: "can you give me an example on the above cases? what should the response be for each of them" },
        ],
    },
    project: "cyber_assistant",
    sure: true,
    seents: T0,
};

const QUESTION_TEXT = "How should a run keep its memory under the machine's limit?";
const APPROACHES = ["One Final at a time", "Memory gate", "Shared node_modules", "Lower parallelism", "Sonnet workers"].map((name) => ({
    name,
    description: "",
    facts: [],
}));
const judgeFile = (question, working) => ({
    v: 1,
    title: "Run memory",
    spec: "",
    question,
    working,
    parts: [],
    history: [],
    done: false,
    check: null,
    run: null,
});
const WEIGHING_FILE = judgeFile({ n: 3, text: QUESTION_TEXT, part: "memory", approaches: APPROACHES }, "Weighing the approaches.");
const JUDGED_FILE = judgeFile(
    { n: 3, text: QUESTION_TEXT, part: "memory", approaches: APPROACHES, judge: { kind: "weighed", added: [], dropped: [] } },
    null
);

const wsh = (command, at, output, durationMs = 300) =>
    bash({ description: command, command, output, ts: T0 + at * S, durationMs });

const noteEntries = (id, title, command) => [
    user("save what is close to done as a note", T0),
    prose("Saving that as a note.", T0 + 2 * S),
    wsh(command, 4, `added note ${id}\n`),
    prose(`Saved in Notes as "${title}".`, T0 + 6 * S),
];
const pipedNote = (title) => `printf '%s' '...' | wsh note add "${title}" --body -`;

// named { entries, seed?, runEvents?, ctx?, compact?, width?, brainstorm?, rpcFails? } the boards scenario composes
// (transcript-boards) through showFixture, which installs brainstorm (the agent's brainstorm file in the store) and
// rpcFails (RpcApi methods that refuse on the page)
export const fixtures = {
    noteFromRecord: {
        seed: { "note:n-11": { id: "n-11", title: NOTE_TITLE, day: "2026-11-16", body: NOTE_BODY } },
        entries: noteEntries("n-11", NOTE_TITLE, pipedNote(NOTE_TITLE)),
    },
    noteFromArgv: {
        entries: noteEntries("n-12", "Two follow-ups", `wsh note add "Two follow-ups" --body "- **First** thing\n- second thing"`),
    },
    noteNotLoaded: {
        rpcFails: ["NoteListCommand"],
        entries: noteEntries("n-lost", "A note that is gone", pipedNote("A note that is gone")),
    },
    compactNote: {
        compact: true,
        width: NARROW,
        seed: { "note:n-13": { id: "n-13", title: "Rendered view: where we left off", day: "2026-11-16", body: "- one" } },
        entries: noteEntries("n-13", "Rendered view: where we left off", pipedNote("Rendered view: where we left off")),
    },
    jiraShow: {
        seed: { "jira:SIEM-1748": TICKET },
        entries: [
            user("make an initiative from SIEM-1748", T0),
            wsh("wsh jira show SIEM-1748", 3, "AI Chatbot improvements\nEnhancement · New\n", 1200),
            prose("The screenshots show the chatbot restating the search results.", T0 + 6 * S),
        ],
    },
    jiraNotLoaded: {
        rpcFails: ["JiraShowCommand"],
        entries: [
            user("read SIEM-9999", T0),
            wsh("wsh jira show SIEM-9999", 3, "AI Chatbot improvements\n", 800),
            prose("I could not read it.", T0 + 6 * S),
        ],
    },
    judgeStarted: {
        ctx: { agentId: JUDGE_AGENT },
        brainstorm: WEIGHING_FILE,
        entries: [
            user("question 3 has five approaches", T0),
            prose("Five ways to keep a run under memory; the judge weighs them blind.", T0 + 2 * S),
            // the call's own time is what the card's elapsed counts from
            { ...wsh("wsh brainstorm judge brainstorm.json", 4, "judge started\n", 400), ts: JUDGE_TS },
        ],
    },
    judgeDone: {
        ctx: { agentId: JUDGE_AGENT },
        brainstorm: JUDGED_FILE,
        entries: [
            user("question 3 has five approaches", T0),
            wsh("wsh brainstorm judge brainstorm.json", 4, "judge started\n", 400),
            prose("Question 3 is in the pane with the judge's pick.", T0 + 90 * S),
        ],
    },
};
// the tab's attached brainstorm file decides whether the store's brainstorm is this judge's record
fixtures.judgePathSame = { ...fixtures.judgeDone, ctx: { agentId: JUDGE_AGENT, brainstormFile: JUDGE_FILE_SAME } };
fixtures.judgePathOther = { ...fixtures.judgeDone, ctx: { agentId: JUDGE_AGENT, brainstormFile: JUDGE_FILE_OTHER } };

const rpcFailsExpr = (names) => `(async () => {
    ${APP_MOD}
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const orig = (window.__notesRpcOrig ??= {});
    for (const n of ["NoteListCommand", "JiraShowCommand"]) {
        orig[n] ??= RpcApi[n];
        RpcApi[n] = ${JSON.stringify(names)}.includes(n) ? async () => { throw new Error("refused on the page: " + n); } : orig[n];
    }
    return true;
})()`;

const brainstormExpr = (file) => `(async () => {
    ${APP_MOD}
    const m = await mod("app/view/agents/brainstormstore.ts");
    m.detachBrainstorm(${JSON.stringify(JUDGE_AGENT)});
    ${file ? `m.attachBrainstorm(${JSON.stringify(JUDGE_AGENT)}, { topic: ${JSON.stringify(JUDGE_TOPIC)}, cwd: ${JSON.stringify(JUDGE_CWD)} }, Date.now());
    m.updateBrainstorm(${JSON.stringify(JUDGE_AGENT)}, (s) => ({ ...s, file: ${JSON.stringify(file)} }));` : ""}
    return true;
})()`;

// the named fixture on screen: its page-side state first, then the transcript
export async function showFixture(h, nameOrFixture, width = WIDE) {
    const source = typeof nameOrFixture === "string" ? fixtures[nameOrFixture] : nameOrFixture;
    const { width: own, brainstorm, rpcFails, entries, ...fixture } = source;
    await h.ev(rpcFailsExpr(rpcFails ?? []));
    if (brainstorm) await setRoster(h, JUDGE_ROSTER);
    await h.ev(brainstormExpr(brainstorm ?? null));
    const at = Date.now() - JUDGE_AGE_MS;
    const stamped = entries.map((e) => (e.ts === JUDGE_TS ? { ...e, ts: at } : e));
    await showTranscript(h, { ...fixture, entries: stamped, width: own ?? width, active: false, renderers: true });
    // every fixture is a finished turn, so its steps and cards sit behind the turn's fold
    await openFolds(h);
}

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const textOf = `const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();`;

const NOTE_CARDS = probe(`
    ${textOf}
    return [...root.querySelectorAll('[data-note-card]')].map((el) => ({
        text: textOf(el),
        inBox: !!el.closest('[data-steps]'),
        inFold: !!el.closest('[data-turn-fold]'),
        facts: !!el.querySelector('button[aria-label="Show the command"]'),
        duration: !!el.querySelector('.font-mono.text-ink-faint'),
        link: !!el.querySelector('button[aria-label="Open note"]'),
        bullets: [...el.querySelectorAll('[data-note-bullet]')].map(textOf),
        strong: [...el.querySelectorAll('[data-note-bullet] .text-foreground')].map(textOf),
        overflows: el.scrollWidth > el.clientWidth + 1,
        ellipsis: [...el.querySelectorAll('span.truncate')].map((s) => s.scrollWidth > s.clientWidth),
    }));
`);

const JIRA_CARD = probe(`
    ${textOf}
    const view = root.querySelector('[data-wsh-view="jira-show"]');
    const card = view?.querySelector('[data-jira-card]');
    return {
        view: view ? textOf(view) : null,
        card: card ? textOf(card) : null,
        description: card?.querySelector('[data-jira-description]') ? textOf(card.querySelector('[data-jira-description]')) : null,
        tiles: card ? [...card.querySelectorAll('[data-jira-attachments] > div')].map(textOf) : [],
        comment: card?.querySelector('[data-jira-comment]') ? textOf(card.querySelector('[data-jira-comment]')) : null,
        project: card?.querySelector('[data-jira-project]') ? textOf(card.querySelector('[data-jira-project]')) : null,
        openInJira: card ? [...card.querySelectorAll('button')].some((b) => b.textContent.includes('Open in Jira')) : false,
        showFull: card ? [...card.querySelectorAll('button')].some((b) => b.textContent.includes('Show the full description')) : false,
        overflows: card ? card.scrollWidth > card.clientWidth + 1 : null,
    };
`);

const JUDGE_CARD = probe(`
    ${textOf}
    const el = root.querySelector('[data-judge-card]');
    if (!el) return null;
    return {
        state: el.getAttribute('data-judge-card'),
        text: textOf(el),
        inBox: !!el.closest('[data-steps]'),
        inFold: !!el.closest('[data-turn-fold]'),
        facts: !!el.querySelector('button[aria-label="Show the command"]'),
        spinner: !!el.querySelector('[role="img"][aria-label="Weighing"]'),
        elapsed: el.querySelector('[data-judge-elapsed]')?.textContent ?? null,
    };
`);

const hasAll = (text, parts) => text != null && parts.every((p) => text.includes(p));
const clickOnPage = (selector, label) =>
    probe(`
    const el = [...root.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(label)}));
    el?.click();
    return !!el;
`);

async function openJiraStep(h) {
    await h.ev(probe(`root.querySelector('[data-step] button[aria-expanded]')?.click(); return true;`));
    await sleep(MOTION_MS);
    return h.ev(JIRA_CARD);
}

export const transcriptNotes = {
    name: "transcript-notes",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        await showFixture(h, "noteFromRecord");
        await h.shot("cdp-shots/transcript-notes-saved-note.png");
        const saved = ((await h.ev(NOTE_CARDS)) ?? [])[0];
        steps.push({
            step: "Saved a note with its bullets: the title, the first bullets from the note's record with their lead-in bright, Open note and the call's facts, inside the turn's fold but no step box",
            ok:
                saved != null &&
                hasAll(saved.text, ["Saved a note", NOTE_TITLE, "Open note"]) &&
                saved.bullets.length === 3 &&
                hasAll(saved.bullets[0], ["Motion sweep follow-ups", "only the flake watch is left"]) &&
                saved.strong.includes("Motion sweep follow-ups") &&
                saved.link === true &&
                saved.facts === true &&
                saved.duration === true &&
                saved.inFold === true &&
                saved.inBox === false &&
                saved.overflows === false,
            detail: JSON.stringify(saved),
        });

        await showFixture(h, "noteFromArgv");
        await h.shot("cdp-shots/transcript-notes-note-argv.png");
        const argv = ((await h.ev(NOTE_CARDS)) ?? [])[0];
        steps.push({
            step: "a note whose body is in the call needs no fetch: its bullets and title come from argv, and Open note from the id wsh printed",
            ok:
                argv != null &&
                hasAll(argv.text, ["Saved a note", "Two follow-ups"]) &&
                argv.bullets.length === 2 &&
                argv.strong.includes("First") &&
                argv.link === true &&
                !argv.text.includes("did not load"),
            detail: JSON.stringify(argv),
        });

        await showFixture(h, "noteNotLoaded");
        await h.shot("cdp-shots/transcript-notes-note-not-loaded.png");
        const lost = ((await h.ev(NOTE_CARDS)) ?? [])[0];
        steps.push({
            step: "a note whose record did not load: the card keeps its title from argv and says so inline",
            ok:
                lost != null &&
                hasAll(lost.text, ["Saved a note", "A note that is gone", "The note did not load"]) &&
                lost.bullets.length === 0 &&
                lost.facts === true,
            detail: JSON.stringify(lost),
        });

        await showFixture(h, "jiraShow");
        const closed = await h.ev(JIRA_CARD);
        const opened = await openJiraStep(h);
        await h.shot("cdp-shots/transcript-notes-jira-show.png");
        steps.push({
            step: "jira show opened as a ticket card: key, summary, type and status, Open in Jira, the description clamped, three attachment tiles, the newest comment, the Arc project, marked as of now",
            ok:
                closed?.card == null &&
                opened?.card != null &&
                hasAll(opened.card, ["SIEM-1748", "AI Chatbot improvements", "Enhancement \u00b7 New", "Open in Jira", "as of now"]) &&
                opened.openInJira === true &&
                opened.showFull === true &&
                opened.description.endsWith("\u2026") &&
                opened.tiles.length === 3 &&
                opened.tiles[0].includes("image-20261109-030246.png") &&
                hasAll(opened.comment, ["Khang Tran", "11-09", "can you give me an example"]) &&
                hasAll(opened.project, ["Arc project", "cyber_assistant"]) &&
                !opened.view.includes("Open full view") &&
                opened.overflows === false,
            detail: JSON.stringify({ closed: closed?.card, opened }),
        });

        await h.ev(clickOnPage("[data-wsh-view=\"jira-show\"] button", "Show the full description"));
        await sleep(200);
        const full = await h.ev(JIRA_CARD);
        steps.push({
            step: "Show the full description opens the whole description and offers Show less",
            ok: full?.description === DESCRIPTION && full.showFull === false && full.card.includes("Show less"),
            detail: JSON.stringify({ description: full?.description?.length, showFull: full?.showFull }),
        });

        await showFixture(h, "jiraNotLoaded");
        const lostTicket = await openJiraStep(h);
        await h.shot("cdp-shots/transcript-notes-jira-not-loaded.png");
        steps.push({
            step: "a ticket that did not load: the opened step says so inline and the raw output stays one click away",
            ok:
                lostTicket?.card == null &&
                hasAll(lostTicket?.view, ["SIEM-9999 did not load", "refused on the page", "Raw output"]) &&
                !lostTicket.view.includes("Open full view"),
            detail: JSON.stringify(lostTicket),
        });

        await showFixture(h, "judgeStarted");
        await h.shot("cdp-shots/transcript-notes-judge-weighing.png");
        const weighing = await h.ev(JUDGE_CARD);
        steps.push({
            step: "Judge started, weighing: question 3, five approaches, the spinner with the elapsed since the call, the question as body, inside the turn's fold but no step box",
            ok:
                weighing?.state === "weighing" &&
                hasAll(weighing.text, ["Judge started", "question 3", "5 approaches", "weighing", QUESTION_TEXT]) &&
                weighing.spinner === true &&
                /^ \u00b7 1m \d{2}s$/.test(weighing.elapsed ?? "") &&
                weighing.facts === true &&
                weighing.inFold === true &&
                weighing.inBox === false,
            detail: JSON.stringify(weighing),
        });

        await showFixture(h, "judgeDone");
        await h.shot("cdp-shots/transcript-notes-judge-done.png");
        const done = await h.ev(JUDGE_CARD);
        steps.push({
            step: "Judge started reads done once Arc's record is on the question: no spinner, no elapsed",
            ok:
                done?.state === "done" &&
                hasAll(done.text, ["Judge started", "question 3", "done", QUESTION_TEXT]) &&
                done.spinner === false &&
                done.elapsed == null,
            detail: JSON.stringify(done),
        });

        await showFixture(h, "judgePathSame");
        const same = await h.ev(JUDGE_CARD);
        await showFixture(h, "judgePathOther");
        await h.shot("cdp-shots/transcript-notes-judge-other-brainstorm.png");
        const other = await h.ev(JUDGE_CARD);
        steps.push({
            step: "the tab's brainstorm file decides the judge's record: the same file (other separators and case) draws its state, another file draws the card without it",
            ok:
                same?.state === "done" &&
                hasAll(same.text, ["question 3", QUESTION_TEXT]) &&
                other?.state === "unknown" &&
                !other.text.includes("question 3") &&
                !other.text.includes(QUESTION_TEXT) &&
                other.facts === true,
            detail: JSON.stringify({ same, other }),
        });

        await showFixture(h, "compactNote");
        await h.shot("cdp-shots/transcript-notes-compact-note.png");
        const compact = ((await h.ev(NOTE_CARDS)) ?? [])[0];
        steps.push({
            step: "compact Saved a note at 380 px: one row with the title cut to fit, no body",
            ok:
                compact != null &&
                hasAll(compact.text, ["Saved a note", "Rendered view: where we left off"]) &&
                compact.link === true &&
                compact.bullets.length === 0 &&
                compact.overflows === false &&
                compact.facts === true,
            detail: JSON.stringify(compact),
        });
        return steps;
    },
    async teardown(h) {
        await h.ev(rpcFailsExpr([]));
        await h.ev(brainstormExpr(null));
        await restoreRoster(h);
        await clearTranscript(h);
    },
};
