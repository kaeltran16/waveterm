// Scenario `transcript-live`: the transcript cards' links and live reads checked by click against real code paths
// (docs/superpowers/plans/2026-11-16-transcript-card-facts.md, Task 7). The real wsh and Go Jira client against the
// fake Jira (jira-fixtures.mjs), Open in Jira with openExternal stubbed, Open note and Open agent through the real
// router, and the brainstorm judge card from what the real poller read off disk for a live session's
// session:brainstorm. A real Jira site is checked only when ARC_LIVE_JIRA_KEY names a ticket on it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPage, closeTabs, makeTab } from "./agent-page-fixtures.mjs";
import { connectFakeJira, startFakeJira } from "./jira-fixtures.mjs";
import { runWsh, vaultRemote, vaultRoot } from "./notes-wsh.mjs";
import { APP_MOD, skipStep } from "./scenarios-shared.mjs";
import { fixtures as notesFixtures } from "./scenarios-transcript-notes.mjs";
import { bash, clearTranscript, openFolds, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const WIDE = 736;
// a step's body opens with the composer's reveal
const MOTION_MS = 700;
const POLL_MS = 200;
// a live read (the fake Jira through wavesrv, a peek's note load, a router landing) lands well inside this
const LAND_MS = 15_000;
// the brainstorm poller ticks every BRAINSTORM_POLL_MS (3 s); the roster has to see the new tab first
const POLLER_MS = 20_000;

const KEY = "PAY-318";
const SUMMARY = "Retry webhook delivery when the partner returns 429";
const TYPE_STATUS = "Story · To Do";
// Jira's attachment field, which the Go client parses into the ticket's attachments
const ATTACHMENTS = [
    { id: "10001", filename: "retry-timeline.png", mimeType: "image/png", size: 48_213, author: { displayName: "Dana K" }, created: "2026-11-12T10:00:00.000+0000" },
    { id: "10002", filename: "partner-429-log.txt", mimeType: "text/plain", size: 2_048, author: { displayName: "Dana K" }, created: "2026-11-12T10:05:00.000+0000" },
];
// the step rows' targets: neither is a substring of the other
const JSON_ROW = "JSON read of the ticket";
const PLAIN_ROW = "Plain read of the ticket";

const BRAINSTORM_TOPIC = "live-judge";
const JUDGED_FILE = notesFixtures.judgeDone.brainstorm;
const LIVE_KEY_ENV = "ARC_LIVE_JIRA_KEY";

const show = (v) => JSON.stringify(v);
const hasAll = (text, parts) => text != null && parts.every((p) => text.includes(p));

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;
const textOf = `const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();`;

const openStep = (label) =>
    probe(`
    const step = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(label)}));
    const btn = step?.querySelector('button[aria-expanded]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return !!btn;
`);

// the one opened jira show view: each pass opens one step
const TICKET = probe(`
    ${textOf}
    const view = root.querySelector('[data-wsh-view="jira-show"]');
    const card = view?.querySelector('[data-jira-card]');
    return {
        view: view ? textOf(view) : null,
        card: card ? textOf(card) : null,
        tiles: card ? [...card.querySelectorAll('[data-jira-attachments] > div')].map(textOf) : [],
        openInJira: card ? [...card.querySelectorAll('button')].some((b) => b.textContent.includes('Open in Jira')) : false,
        asOfNow: card ? textOf(card).includes('as of now') : null,
    };
`);

const CLICK_OPEN_IN_JIRA = probe(`
    const b = [...root.querySelectorAll('[data-jira-card] button')].find((e) => e.textContent.includes('Open in Jira'));
    b?.click();
    return !!b;
`);

const clickLabel = (label) =>
    probe(`
    const b = root.querySelector('button[aria-label=${JSON.stringify(label)}]') ??
        [...root.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)});
    b?.click();
    return !!b;
`);

const JUDGE_CARD = probe(`
    ${textOf}
    const el = root.querySelector('[data-judge-card]');
    return el ? { state: el.getAttribute('data-judge-card'), text: textOf(el) } : null;
`);

async function waitFor(h, expr, ms = LAND_MS) {
    let last = null;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(POLL_MS)) {
        last = await h.ev(expr);
        if (last?.ok) return last;
    }
    return last;
}

// JiraShowCommand refused on the page, or put back
const refuseJiraShow = (on) => `(async () => {
    ${APP_MOD}
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    if (${on}) {
        window.__liveJiraShow ??= RpcApi.JiraShowCommand;
        RpcApi.JiraShowCommand = async () => { throw new Error("refused on the page: JiraShowCommand"); };
    } else if (window.__liveJiraShow) {
        RpcApi.JiraShowCommand = window.__liveJiraShow;
        delete window.__liveJiraShow;
    }
    return true;
})()`;

const stubOpenExternal = `(() => {
    window.__liveOpenExternal ??= window.api.openExternal;
    window.__liveOpened = [];
    window.api.openExternal = (u) => { window.__liveOpened.push(u); };
    return true;
})()`;

const restoreOpenExternal = `(() => {
    if (window.__liveOpenExternal) window.api.openExternal = window.__liveOpenExternal;
    delete window.__liveOpenExternal;
    const opened = window.__liveOpened ?? [];
    delete window.__liveOpened;
    return opened;
})()`;

const closePeekExpr = `(async () => {
    ${APP_MOD}
    const { closePeek } = await mod("app/view/jarvis/peekstore.ts");
    closePeek();
    return true;
})()`;

const notePeek = (id, title) => `(async () => {
    ${APP_MOD}
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { peekItemAtom } = await mod("app/view/jarvis/peekstore.ts");
    const item = globalStore.get(peekItemAtom);
    const el = document.querySelector('[data-pet-peek-item="note"]');
    const text = (el?.textContent ?? "").replace(/\\s+/g, " ");
    return {
        ok: item?.target?.kind === "note" && item.target.noteId === ${JSON.stringify(id)} && item.status === "ready" &&
            el?.getAttribute("data-pet-peek-status") === "ready" && text.includes(${JSON.stringify(title)}),
        item,
        popup: el ? { status: el.getAttribute("data-pet-peek-status"), text: text.slice(0, 200) } : null,
    };
})()`;

const landing = (tabId) =>
    `const model = agentsModel();
    const surface = globalStore.get(model.surfaceAtom);
    const focus = globalStore.get(model.focusIdAtom);
    return { ok: surface === "agent" && focus === ${JSON.stringify(tabId)}, surface, focus };`;

// the session as the cockpit's roster has it, and the brainstorm the poller attached and read for it
const polled = (tabId) =>
    `const { getBrainstorm } = await mod("app/view/agents/brainstormstore.ts");
    const model = agentsModel();
    const vm = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)].find((a) => a.id === ${JSON.stringify(tabId)});
    const s = getBrainstorm(${JSON.stringify(tabId)});
    return {
        ok: vm?.brainstormFile != null && s?.file != null && s.modifiedMs != null,
        brainstormFile: vm?.brainstormFile ?? null,
        path: s?.path ?? null,
        modifiedMs: s?.modifiedMs ?? null,
        question: s?.file?.question?.text ?? null,
        judge: s?.file?.question?.judge?.kind ?? null,
    };`;

async function waitPage(h, body, ms) {
    let last = null;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(POLL_MS)) {
        last = await agentPage(h, body);
        if (last?.ok) return last;
    }
    return last;
}

// every turn here is finished, so it starts folded: open it, so its step rows mount
const showLive = async (h, entries, opts = {}) => {
    await showTranscript(h, { entries, width: WIDE, active: false, renderers: true, ...opts });
    await openFolds(h);
};

const jiraEntries = (jsonOut, plainOut) => [
    user(`read ${KEY}`, T0),
    bash({ description: JSON_ROW, command: `wsh jira show ${KEY} --json`, output: jsonOut, ts: T0 + 2 * S, durationMs: 900 }),
    prose("That is the ticket as JSON.", T0 + 4 * S),
    bash({ description: PLAIN_ROW, command: `wsh jira show ${KEY}`, output: plainOut, ts: T0 + 6 * S, durationMs: 800 }),
    prose("And as the terminal prints it.", T0 + 8 * S),
];

// Decision 8: the real site, only when ARC_LIVE_JIRA_KEY names a ticket and the app's own Jira passes its check on a
// site that is not a fake. Runs before the fake is connected: connecting it replaces the app's token for good.
async function liveJiraStep(h) {
    const name = "6. a real Jira site: wsh jira show --json for ARC_LIVE_JIRA_KEY draws its ticket card";
    const key = (process.env[LIVE_KEY_ENV] ?? "").trim().toUpperCase();
    if (!key) {
        return skipStep(name, `${LIVE_KEY_ENV} is unset; in the dev app run ${LIVE_KEY_ENV}=<KEY> task verify:ui -- transcript-live`);
    }
    const conn = await h.rpc("jiraconnection", { test: true }).catch((e) => ({ error: String(e?.message ?? e) }));
    if (!conn?.ok) return skipStep(name, `the app's Jira check does not pass: ${show(conn)}`);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(conn.site ?? "")) {
        return skipStep(name, `the app's Jira site ${conn.site} is a fake`);
    }
    if (!(await waitSeam(h))) return { step: name, ok: false, detail: "the dev fixture seam never came up" };
    const [r] = await runWsh(h, [["jira", "show", key, "--json"]]);
    await showLive(h, [user(`read ${key}`, T0), bash({ description: JSON_ROW, command: `wsh jira show ${key} --json`, output: r.stdout, ts: T0 + S, durationMs: 900 })]);
    await h.ev(openStep(JSON_ROW));
    await sleep(MOTION_MS);
    const t = await h.ev(TICKET);
    await h.shot("cdp-shots/transcript-live-real-jira.png");
    await clearTranscript(h);
    return {
        step: name,
        ok: r.code === 0 && hasAll(t?.card, [key, "Open in Jira"]) && t.asOfNow === false,
        detail: show({ site: conn.site, code: r.code, stderr: r.stderr, ticket: t }),
    };
}

function writeBrainstorm(dir) {
    const topicDir = join(dir, ".superpowers", "brainstorm", BRAINSTORM_TOPIC);
    mkdirSync(topicDir, { recursive: true });
    const path = join(topicDir, "brainstorm.json");
    writeFileSync(path, JSON.stringify(JUDGED_FILE, null, 2));
    return path;
}

async function jiraSteps(h, ctx, steps) {
    const before = ctx.fake.state.calls.length;
    const [json, plain] = await runWsh(h, [["jira", "show", KEY, "--json"], ["jira", "show", KEY]]);
    let printed = null;
    try {
        printed = JSON.parse(json.stdout);
    } catch {
        /* the step below says what was printed */
    }
    const asked = ctx.fake.state.calls.slice(before).filter((c) => c.startsWith(`GET /rest/api/3/issue/${KEY}`)).length;
    steps.push({
        step: "1a. the real wsh and Go client read the ticket from the fake Jira, as JSON and plainly",
        ok: json.code === 0 && plain.code === 0 && printed?.ticket?.key === KEY && printed.ticket.attachments?.length === 2 && plain.stdout.startsWith(`${SUMMARY}\n`) && asked === 2,
        detail: show({ json, plain, asked }),
    });
    const entries = jiraEntries(json.stdout, plain.stdout);

    await h.ev(refuseJiraShow(true));
    try {
        await showLive(h, entries);
        await h.ev(openStep(JSON_ROW));
        await sleep(MOTION_MS);
        const fromOutput = await h.ev(TICKET);
        await h.shot("cdp-shots/transcript-live-jira-json.png");
        steps.push({
            step: "1b. JiraShowCommand refused on the page: the --json call's view still draws the ticket from its own output (key, summary, type · status, attachments, Open in Jira)",
            ok:
                hasAll(fromOutput?.card, [KEY, SUMMARY, TYPE_STATUS, "Open in Jira"]) &&
                fromOutput.tiles.length === ATTACHMENTS.length &&
                ATTACHMENTS.every((a, i) => fromOutput.tiles[i]?.includes(a.filename)) &&
                fromOutput.asOfNow === false,
            detail: show(fromOutput),
        });
    } finally {
        await h.ev(refuseJiraShow(false));
    }

    await showLive(h, entries);
    await h.ev(openStep(PLAIN_ROW));
    const fromRpc = await waitFor(h, `(() => { const t = ${TICKET}; return t && { ok: t.card != null, ...t }; })()`);
    await h.shot("cdp-shots/transcript-live-jira-plain.png");
    steps.push({
        step: "1c. allowed, the plain call's view draws the ticket from the real JiraShowCommand, as of now",
        ok:
            hasAll(fromRpc?.card, [KEY, SUMMARY, TYPE_STATUS, "Open in Jira"]) &&
            fromRpc.tiles.length === ATTACHMENTS.length &&
            fromRpc.asOfNow === true,
        detail: show(fromRpc),
    });

    const want = `${ctx.fake.url}/browse/${KEY}`;
    await h.ev(stubOpenExternal);
    let clicked = false;
    let opened = [];
    try {
        clicked = await h.ev(CLICK_OPEN_IN_JIRA);
        await sleep(POLL_MS);
    } finally {
        opened = (await h.ev(restoreOpenExternal)) ?? [];
    }
    steps.push({
        step: "2. Open in Jira: the click asks the host to open the site's browse URL for the ticket",
        ok: clicked === true && opened.length === 1 && opened[0] === want,
        detail: show({ clicked, opened, want }),
    });
}

async function noteStep(h, ctx, steps) {
    const name = "3. Open note: a note made through the app's RPC, its note-add card's Open note peeks that note";
    if (ctx.noteError != null) {
        steps.push({ step: name, ok: false, detail: ctx.noteError });
        return;
    }
    const title = `verify transcript-live ${ctx.stamp}`;
    const note = await h.rpc("noteadd", { title, body: "- the link lands on this note" });
    await showLive(h, [
        user("save that as a note", T0),
        bash({ description: "Save the note", command: `wsh note add "${title}" --body "- the link lands on this note"`, output: `added note ${note.id}\n`, ts: T0 + 2 * S, durationMs: 300 }),
        prose("Saved.", T0 + 4 * S),
    ]);
    const clicked = await h.ev(clickLabel("Open note"));
    const peeked = await waitFor(h, notePeek(note.id, title));
    await h.shot("cdp-shots/transcript-live-open-note.png");
    await h.ev(closePeekExpr);
    steps.push({ step: name, ok: clicked === true && peeked?.ok === true, detail: show({ id: note.id, clicked, peeked }) });
}

async function agentStep(h, ctx, steps) {
    const name = "4. Open agent: the agents-read card for a live session's tab lands on the Agent surface with it selected";
    const prev = await agentPage(h, `const model = agentsModel(); return globalStore.get(model.focusIdAtom);`);
    // the server lists only tabs with a live claude or pi status, so the card's roster names this tab by seed
    const roster = { agents: [{ tabid: ctx.tab.tabId, name: ctx.label, projectpath: ctx.project, project: "", runid: "", harness: "claude", state: "idle" }] };
    await showLive(
        h,
        [
            user("what did the other session find?", T0),
            bash({ description: "Read the other session", command: `wsh agents read ${ctx.tab.tabId}`, output: "Nothing new since the last run.", ts: T0 + 2 * S, durationMs: 300 }),
            prose("Nothing new.", T0 + 4 * S),
        ],
        { seed: { agents: roster } }
    );
    const clicked = await h.ev(clickLabel("Open agent"));
    const landed = await waitPage(h, landing(ctx.tab.tabId), LAND_MS);
    await h.shot("cdp-shots/transcript-live-open-agent.png");
    // back where the next step expects: the cockpit, the focus as it was
    await agentPage(h, `const model = agentsModel(); globalStore.set(model.focusIdAtom, ${show(prev ?? null)}); globalStore.set(model.surfaceAtom, "cockpit"); return true;`);
    steps.push({ step: name, ok: clicked === true && landed?.ok === true, detail: show({ clicked, landed }) });
}

async function judgeStep(h, ctx, steps) {
    const read = await waitPage(h, polled(ctx.tab.tabId), POLLER_MS);
    const q = JUDGED_FILE.question;
    await showLive(
        h,
        [
            user(`question ${q.n} has ${q.approaches.length} approaches`, T0),
            bash({ description: "wsh brainstorm judge brainstorm.json", command: "wsh brainstorm judge brainstorm.json", output: "judge started\n", ts: T0 + 2 * S, durationMs: 400 }),
            prose("The judge's pick is in the pane.", T0 + 90 * S),
        ],
        { liveAgent: ctx.tab.tabId }
    );
    const card = await h.ev(JUDGE_CARD);
    await h.shot("cdp-shots/transcript-live-judge.png");
    steps.push({
        step: "5. the judge card draws the judged question from what the real poller read off disk, its brainstorm file from the session's session:brainstorm",
        ok:
            read?.ok === true &&
            read.brainstormFile === ctx.brainstormPath &&
            read.question === q.text &&
            card?.state === "done" &&
            hasAll(card.text, [`question ${q.n}`, q.text]),
        detail: show({ read, card }),
    });
}

// an ended session whose last call never got its result: the row reads stopped, with no spinner and no clock counting
// from the call to now. A plain command: a session-closing wsh call (complete, dag final) lays out landed (a1f20505e)
const STOPPED_ROW = "Run the final verify";
async function stoppedStep(h) {
    const entries = [
        user("Run the final verify.", T0),
        prose("Running it.", T0 + S),
        bash({ description: STOPPED_ROW, command: "node scripts/cdp/final-verify.mjs", ts: T0 + 2 * S, pending: true }),
    ];
    await showLive(h, entries);
    const s = await h.ev(`(() => {
        const step = [...(document.querySelector(${JSON.stringify(ROOT)})?.querySelectorAll('[data-step]') ?? [])].find((e) => e.textContent.includes(${JSON.stringify(STOPPED_ROW)}));
        if (!step) return null;
        return {
            status: step.getAttribute('data-step-status'),
            spinner: !!step.querySelector('[aria-label="Running"]'),
            elapsed: step.querySelector('[data-step-elapsed]')?.textContent ?? null,
            text: step.textContent,
        };
    })()`);
    await h.shot("cdp-shots/transcript-live-stopped.png");
    return {
        step: "an inactive transcript's last pending step draws stopped, with no spinner and no elapsed clock",
        ok: s?.status === "stopped" && s.spinner === false && s.elapsed === null && s.text.includes("stopped"),
        detail: show(s),
    };
}

export const transcriptLive = {
    name: "transcript-live",
    surface: "cockpit",
    async arrange(h) {
        const stamp = Date.now().toString(36);
        const ctx = { stamp, tabIds: [], label: `verify-live-${stamp}` };
        // a throw past this point still returns ctx, so teardown undoes whatever was already done
        try {
            ctx.liveJira = await liveJiraStep(h);
            ctx.project = mkdtempSync(join(tmpdir(), "verify-transcript-live-"));
            ctx.brainstormPath = writeBrainstorm(ctx.project);
            ctx.fake = await startFakeJira();
            ctx.fake.state.issues[KEY].attachments = ATTACHMENTS;
            ctx.restore = await connectFakeJira(h, ctx.fake);
            const vault = await vaultRoot(h);
            const remote = vaultRemote(vault);
            if (remote) ctx.noteError = `the vault ${vault} has a git remote (${remote}): not writing a fixture note into it`;
            // a session the Agent surface lists by its term block's cwd; nothing runs in it
            ctx.tab = await makeTab(h, ctx, {
                label: ctx.label,
                blockMeta: { view: "term", controller: null, "cmd:cwd": ctx.project },
                tabMeta: { "session:agent": "terminal", "session:brainstorm": ctx.brainstormPath },
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) return [{ step: "arrange the fake Jira, the session and its brainstorm", ok: false, detail: ctx.arrangeError }];
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        steps.push(await stoppedStep(h));
        await jiraSteps(h, ctx, steps);
        await noteStep(h, ctx, steps);
        await agentStep(h, ctx, steps);
        await judgeStep(h, ctx, steps);
        steps.push(ctx.liveJira);
        return steps;
    },
    async teardown(h, ctx) {
        const failed = [];
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                failed.push(`${what}: ${e?.message ?? e}`);
            }
        };
        await step("put JiraShowCommand back", () => h.ev(refuseJiraShow(false)));
        await step("put openExternal back", () => h.ev(restoreOpenExternal));
        await step("close the peek", () => h.ev(closePeekExpr));
        await step("clear the transcript", () => clearTranscript(h));
        await step("close the session's tab", () => closeTabs(h, ctx));
        await step("delete the note", async () => {
            for (const n of (await h.rpc("notelist", null)) ?? []) {
                if (n.title.includes(ctx.stamp)) await h.rpc("notedelete", { id: n.id });
            }
        });
        if (ctx.restore) await step("restore the Jira settings", () => ctx.restore());
        if (ctx.fake) await step("stop the fake Jira", () => ctx.fake.close());
        if (ctx.project) await step("remove the temp project", () => rmSync(ctx.project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
        if (failed.length > 0) throw new Error(failed.join("; "));
    },
};
