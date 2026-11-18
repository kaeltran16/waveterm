// Scenario `transcript-dagactions`: the lead's action cards on a run's tasks and asks (wshcards-dagactions.tsx): the
// worker question the lead answered, the Told, Amended, Retried, Asked Arc to merge and Escalated rows, the
// Forwarded card with its note, a compact row at 380 px, and a card whose run events never loaded.

import { agentPage } from "./agent-page-fixtures.mjs";
import { bash, clearTranscript, openFolds, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const WIDE = 736;
const NARROW = 380;
const RUN = "run-dagactions";
const CHANNEL = "ch-dagactions";
const LEAD = { channelId: CHANNEL, role: { kind: "lead", runId: RUN } };
// openref's refusal for a run Arc cannot load
const RUN_GONE = "That run no longer exists";

const ASK_QUESTION = "When truncate shortens a string, should the result end with the single character … or with three dots ...?";
const OPTIONS = [
    { label: "… (single char)", description: "Ellipsis character U+2026. One character shorter than dots, so more text fits in n." },
    { label: "... (three dots)", description: "Three ASCII periods. Works in any encoding, and tests compare plain ASCII." },
];
const FORWARD_NOTE =
    "Scope call: should a bound arrow store the box's new x/y when the box glides, or keep its creation x/y and only redraw the path? I recommend storing the new x/y; it touches only sync.";

const runEvent = (kind, ts, detail) => ({
    id: `${kind}-${ts}`,
    runid: RUN,
    channelid: CHANNEL,
    ts,
    kind,
    detail: JSON.stringify(detail),
});

// a successful wsh call of the lead's, 0.2 s long
const call = (command, at, durationMs = 200) =>
    bash({ description: command, command, output: "ok", ts: T0 + at * S, durationMs });

// named { entries, seed?, runEvents?, ctx?, compact?, width? } the boards scenario composes (transcript-boards)
export const fixtures = {
    answered: {
        ctx: LEAD,
        runEvents: {
            [RUN]: [
                runEvent("child-ask", T0 + 10 * S, {
                    taskid: "t-4",
                    label: "truncate",
                    header: "Suffix",
                    question: ASK_QUESTION,
                    options: OPTIONS,
                }),
            ],
        },
        entries: [
            user("t-4 asks a question", T0),
            call(`wsh jarvis dag answer t-4 '[{"selectedindexes":[0]}]'`, 20),
            prose("Answered t-4: the single character, so more text fits.", T0 + 22 * S),
        ],
    },
    toldAmended: {
        ctx: LEAD,
        entries: [
            user("t-3 is about to copy add instead of importing it", T0),
            call(`wsh jarvis dag amend t-3 "Files now include pkg/jarvis/run.go (BuildOrchestratePrompt is the only caller)"`, 5),
            call(`wsh jarvis dag amend t-4 "Files now include scripts/cdp-e2e-runs-piece4.mjs; assert arc:brainstorm"`, 6),
            prose("Both notes are on their tasks.", T0 + 8 * S),
            call(`wsh jarvis dag tell t-3 "multiply reuses add from t-1; import it, don't copy it"`, 30),
        ],
    },
    recovery: {
        ctx: LEAD,
        runEvents: { [RUN]: [runEvent("task-escalated", T0 + 41 * S, { taskid: "t-7", model: "opus", runtime: "claude" })] },
        entries: [
            user("t-5 failed, t-6 is blocked, t-7 failed twice", T0),
            prose("Nothing ran, so nothing is lost. Retrying it.", T0 + 2 * S),
            call("wsh jarvis dag retry t-5", 3),
            call("wsh jarvis dag merge --continue t-6", 20),
            prose("Both attempts failed on the same hit-test bug. Escalating to Opus.", T0 + 38 * S),
            call("wsh jarvis dag escalate t-7 --model opus --runtime claude", 40),
        ],
    },
    forwarded: {
        ctx: LEAD,
        entries: [
            user("t-4 is stuck on a scope call", T0),
            call(`wsh jarvis dag forward t-4 "${FORWARD_NOTE}"`, 5),
            prose("t-4 waits for your call on the arrow x/y.", T0 + 7 * S),
        ],
    },
    compactAmended: {
        ctx: LEAD,
        compact: true,
        width: NARROW,
        entries: [
            user("t-3 and t-4 name the wrong files", T0),
            call(`wsh jarvis dag amend t-3 "Files now include pkg/jarvis/run.go"`, 5),
            call(`wsh jarvis dag amend t-4 "Files now include the e2e script"`, 6),
        ],
    },
    // an answer whose run events never load: the card draws from the call's argv alone
    answeredNoEvents: {
        ctx: { channelId: CHANNEL, role: { kind: "lead", runId: "run-never-loaded" } },
        entries: [user("t-4 asks a question", T0), call(`wsh jarvis dag answer t-4 '[{"selectedindexes":[1]}]'`, 20)],
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const CARDS = probe(`
    const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    return [...root.querySelectorAll('[data-dag-action]')].map((el) => ({
        kind: el.getAttribute('data-dag-action'),
        text: textOf(el),
        inBox: !!el.closest('[data-steps]'),
        inFold: !!el.closest('[data-turn-fold]'),
        facts: !!el.querySelector('button[aria-label="Show the command"]'),
        duration: !!el.querySelector('.font-mono.text-ink-faint'),
        overflows: el.scrollWidth > el.clientWidth + 1,
        picked: [...el.querySelectorAll('[data-answer-option]')].map((o) => o.getAttribute('data-answer-option')),
        check: el.querySelectorAll('[role="img"][aria-label="Picked"]').length,
        link: [...el.querySelectorAll('button')].some((b) => b.textContent.includes('Answer in the run')),
        ellipsis: [...el.querySelectorAll('span.truncate')].map((s) => s.scrollWidth > s.clientWidth),
    }));
`);

async function show(h, name, width = WIDE) {
    const { width: own, ...fixture } = fixtures[name];
    await showTranscript(h, { ...fixture, width: own ?? width, active: false, renderers: true });
    // every fixture is a finished turn, so its cards sit behind the turn's fold
    await openFolds(h);
    return (await h.ev(CARDS)) ?? [];
}

const only = (cards, kind) => cards.filter((c) => c.kind === kind);
const hasAll = (text, parts) => parts.every((p) => text.includes(p));

export const transcriptDagActions = {
    name: "transcript-dagactions",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        const answered = await show(h, "answered");
        await h.shot("cdp-shots/transcript-dagactions-answered.png");
        const card = only(answered, "answer")[0];
        steps.push({
            step: "worker question answered by the lead: the question, both options with the picked one checked, and who delivered it",
            ok:
                card != null &&
                hasAll(card.text, ["t-4", "truncate", "Suffix", ASK_QUESTION, OPTIONS[0].label, OPTIONS[1].label, OPTIONS[0].description]) &&
                card.text.includes("The lead answered · delivered to t-4") &&
                JSON.stringify(card.picked) === JSON.stringify(["picked", "open"]) &&
                card.check === 1 &&
                card.inFold === true &&
                card.inBox === false &&
                card.facts === true,
            detail: JSON.stringify(card),
        });

        const told = await show(h, "toldAmended");
        await h.shot("cdp-shots/transcript-dagactions-told-amended.png");
        const amended = only(told, "amend");
        const tellRow = only(told, "tell")[0];
        steps.push({
            step: "Told and Amended rows: verb, task id and text on one line each, inside the turn's fold but no step box, with the call's facts",
            ok:
                amended.length === 2 &&
                hasAll(amended[0].text, ["Amended", "t-3", "pkg/jarvis/run.go"]) &&
                hasAll(amended[1].text, ["Amended", "t-4", "scripts/cdp-e2e-runs-piece4.mjs"]) &&
                tellRow != null &&
                hasAll(tellRow.text, ["Told", "t-3", `"multiply reuses add from t-1; import it, don't copy it"`]) &&
                [...amended, tellRow].every((c) => c.inFold && !c.inBox && c.facts && c.duration),
            detail: JSON.stringify({ amended, tellRow }),
        });

        const recovery = await show(h, "recovery");
        await h.shot("cdp-shots/transcript-dagactions-recovery.png");
        const retried = only(recovery, "retry")[0];
        const merged = only(recovery, "merge")[0];
        const escalated = only(recovery, "escalate")[0];
        steps.push({
            step: "Retried, Asked Arc to merge and Escalated rows: the retry line, the merge ask, the model from the run's event",
            ok:
                retried != null &&
                hasAll(retried.text, ["Retried", "t-5", "a fresh worker starts when a slot is free"]) &&
                merged != null &&
                hasAll(merged.text, ["Asked Arc to merge", "t-6"]) &&
                escalated != null &&
                hasAll(escalated.text, ["Escalated", "t-7", "re-queued on claude opus"]) &&
                [retried, merged, escalated].every((c) => c.inFold && !c.inBox && c.facts),
            detail: JSON.stringify({ retried, merged, escalated }),
        });

        const forwarded = only(await show(h, "forwarded"), "forward")[0];
        await h.shot("cdp-shots/transcript-dagactions-forwarded.png");
        steps.push({
            step: "Forwarded to you with its note: the task, who it waits on, the note as body and a link into the run",
            ok:
                forwarded != null &&
                hasAll(forwarded.text, ["Forwarded to you", "t-4", "waits on you", "Answer in the run", FORWARD_NOTE]) &&
                forwarded.link === true &&
                forwarded.inFold &&
                !forwarded.inBox &&
                forwarded.facts === true,
            detail: JSON.stringify(forwarded),
        });

        // off the Agent surface the link has no workspace pane to open beside, so it opens the run as it always did;
        // the fixture's run does not exist, so the router's refusal is what shows the open was attempted
        const opened = await agentPage(
            h,
            `const T = await mod("app/cockpit/notificationstore.ts");
            const root = document.querySelector(${JSON.stringify(ROOT)});
            const link = [...(root?.querySelectorAll('[data-dag-action="forward"] button') ?? [])].find((b) => b.textContent.includes("Answer in the run"));
            if (!link) return { clicked: false };
            link.click();
            const refused = await until(() => globalStore.get(T.toastsAtom).some((t) => t.title === ${JSON.stringify(RUN_GONE)}));
            const out = {
                clicked: true,
                refused,
                pane: document.querySelector('aside[aria-label="Workspace"]') != null,
            };
            globalStore.get(T.toastsAtom).filter((t) => t.title === ${JSON.stringify(RUN_GONE)}).forEach((t) => T.dismissToast(t.id));
            return out;`
        );
        steps.push({
            step: "off the Agent surface, Answer in the run opens the run through the router, not a workspace tab",
            ok: opened.clicked && opened.refused && !opened.pane,
            detail: JSON.stringify(opened),
        });

        const compact =only(await show(h, "compactAmended"), "amend");
        await h.shot("cdp-shots/transcript-dagactions-compact-amended.png");
        steps.push({
            step: "compact Amended at 380 px: two rows that fit the card width",
            ok:
                compact.length === 2 &&
                compact.every((c) => !c.overflows && c.facts) &&
                hasAll(compact[0].text, ["Amended", "t-3"]) &&
                hasAll(compact[1].text, ["Amended", "t-4"]),
            detail: JSON.stringify(compact),
        });

        const bare = only(await show(h, "answeredNoEvents"), "answer")[0];
        await h.shot("cdp-shots/transcript-dagactions-answer-no-events.png");
        steps.push({
            step: "an answer whose run events never loaded: the card still draws from argv, with the picked option beside",
            ok:
                bare != null &&
                hasAll(bare.text, ["t-4", "Picked option 2", "The lead answered · delivered to t-4"]) &&
                bare.check === 1,
            detail: JSON.stringify(bare),
        });
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
