// Scenario `transcript-census-wsh`: the census's wsh card fixes, each at the census's two hosts (rendered and compact),
// from the specimens named in the plan: a chunk known only by its title stays within the column (108), an age past an
// hour reads in hours and days (137), a change card shows no raw wsh output (45, 50), the dag answer names the picked
// option and the task (85), a help call draws no change card and no row ends on an empty noun (14, 27, 71), and the
// one-line events (Retried, Asked Arc to merge, Run complete, Saved a note) share one flat row (71, 89).

import { bash, clearTranscript, HOSTS, openFolds, prose, ROOT, showAt, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const S = 1000;
const MIN = 60 * S;
// a step's open motion settles before a step reads its view
const MOTION_MS = 600;

const RUN = "run-census-wsh";
const CHANNEL = "ch-census-wsh";
const LEAD = { channelId: CHANNEL, role: { kind: "lead", runId: RUN } };

const call = (description, command, output, at, durationMs = 600) =>
    bash({ description, command, output, ts: T0 + at * S, durationMs });

// ---- 108: a chunk status whose effort will not load, so the chunk is known only by its long title
const CHUNK_TITLE =
    "LLM 1: one verdict rubric (real = attack step shown, succeeded or not, however common; benign = identified, not an attack; cannot_tell = not identified) plus attack_result and scope enums on finish";
const chunkStatus = [
    user("do them all", T0),
    call(
        `cd "C:/work/detector" && wsh effort chunk status 7ea571f2`,
        `cd "C:/work/detector" && wsh effort chunk status 7ea571f2-62cc-4fee-878f-1e525cf6b86a "${CHUNK_TITLE}" active --note "11-18: user approved doing all five chunks" >/dev/null; sed -n 130,140p src/services/hypothesis/investigation_goal.py`,
        "class NamedMember(BaseModel):\n    model_config = ConfigDict(extra=\"forbid\")",
        2,
        1430
    ),
    prose("Chunk 1 is active.", T0 + 4 * S),
];

// ---- 137: runs attention items waiting for weeks (the census printed "58867m 57s")
const WAITED_MIN = [63268, 63258, 58867];
const attentionSeed = () => ({
    "runs-attention": WAITED_MIN.map((m, i) => ({
        kind: "run-ack",
        key: `ack-${i}`,
        runid: `run-old-${i}`,
        source: i < 2 ? "Do not brainstorm" : "Child ask plan",
        text: "Finished, but 1 thing was not verified.",
        action: "Acknowledge",
        phaseidx: 0,
        waitingsince: Date.now() - m * MIN - 44 * S,
    })),
});
const ATTENTION_CMD = "wsh runs list 2>&1 | head -20; echo ---; wsh runs attention 2>&1 | head -20";
const attention = [user("what is waiting?", T0), call(ATTENTION_CMD, ATTENTION_CMD, "", 2, 2367)];

// ---- 45, 50: change cards whose effort will not load; wsh printed "applied to effort effort:<id>" and an effort show
const EFFORT_SHOW_DUMP = `# Antigravity /swarm: lessons for the orchestrator engine (active) — 1/5
project  waveterm
  1. [done] Compare /swarm with the engine on the resource-management replay
      · 11-18 10:54: marked done · Report: ~/arc-bench/arc-vs-swarm.md
  2. [active] Decide: bench delegated cheap-model exploration before the lead plans?`;
const APPLIED = "appendNote applied to effort effort:25e5eb18-863e-4e80-b585-60124822822b";
const changes = [
    user("update the initiative", T0),
    call(
        "Note the approved design on the initiative",
        `wsh effort chunk note effort:25e5eb18-863e-4e80-b585-60124822822b 1 --note "Design approved 2026-11-16: docs/superpowers/specs/2026-11-16-slim-superpowers-design.md" 2>&1 | tail -1`,
        APPLIED,
        2,
        650
    ),
    call(
        "Tick the comparison done and annotate the decision chunks",
        `E=b758746d-5105-4456-b80a-d73acc8ccffb && wsh effort chunk status $E "Compare /swarm with the engine on the resource-management replay" done --note "Report: ~/arc-bench/arc-vs-swarm.md" >/dev/null && wsh effort show $E`,
        EFFORT_SHOW_DUMP,
        4,
        835
    ),
    prose("Both are recorded.", T0 + 6 * S),
];

// ---- 85: the lead answered t-1's question with option 0; t-2's answer has no ask to match
const OPTION0 = "Pin old widths in test (Recommended)";
const TASK_LABEL = "Residual model module and settings";
const answerEvents = {
    [RUN]: [
        {
            id: "child-ask-1",
            runid: RUN,
            channelid: CHANNEL,
            ts: T0 + 1 * S,
            kind: "child-ask",
            detail: JSON.stringify({
                taskid: "t-1",
                label: TASK_LABEL,
                header: "Divergence",
                question: "How should Task 1 handle the 2 divergence tests the new default breaks?",
                options: [
                    { label: OPTION0, description: "One-line change in test_autoencoder_divergence.py." },
                    { label: "Leave them failing", description: "Touch only Task 1's files." },
                    { label: "Keep old default for now", description: "Let Task 2 change it." },
                ],
            }),
        },
    ],
};
const answers = [
    user("wake: t-1 asks a question", T0),
    call("Answer task 1 question with option 0", `wsh jarvis dag answer t-1 '[{"selectedindexes":[0]}]'`, "answer delivered to task t-1", 3, 1134),
    call("Answer task 2 question with option 0", `wsh jarvis dag answer t-2 '[{"selectedindexes":[0]}]'`, "answer delivered to task t-2", 5, 900),
    prose("Answered both.", T0 + 7 * S),
];

// ---- 14, 27, 71: help calls beside real ones, and a note on a chunk named only by its label
const helps = [
    user("resubmit the plan", T0),
    call(
        "Commit plan revision and show submit help",
        `git commit -q -m "docs: revise plan" && git log --oneline -1 && wsh jarvis dag submit --help 2>&1 | head -20`,
        "7742a6a1a docs: revise plan\nValidate and submit a plan file as this run's DAG.",
        2,
        619
    ),
    call(
        "Resubmit revised plan",
        `wsh jarvis dag submit --plan "C:/work/plans/2026-11-17-plan-skill-bench.md" 2>&1 | tail -15`,
        "dag 287d2dff-2c4f-4c92-aace-15ae14e11871 submitted (6 tasks, 5 lanes, longest chain 2, parallelism 3)",
        4,
        844
    ),
    call("Check dag amend usage", "wsh jarvis dag amend --help 2>&1 | head -15", "add a note to a task that has not started", 6, 431),
    call(
        "Check effort chunk note syntax",
        "wsh effort chunk --help 2>&1 | sed -n 1,30p; wsh effort chunk note --help 2>&1 | sed -n 1,20p",
        "manage an effort's chunks",
        8,
        513
    ),
    call(
        "Note the bench on its chunk",
        `wsh effort chunk note e-census-gone "Ship the bench later" --note "after the quota resets"`,
        "appendNote applied to effort effort:e-census-gone",
        10,
        500
    ),
    prose("Resubmitted.", T0 + 12 * S),
];

// ---- 71, 89 (F6): one-line events with no body
const oneLiners = [
    user("continue the merge", T0),
    call(
        "Commit the test fix and continue t-6's merge",
        `git commit -q -m "test(orchestrate): gate memgate again" && wsh jarvis dag merge t-6 --continue 2>&1`,
        "task t-6 continued; the plan's Verify, if it has one, runs next and a failure wakes you",
        2,
        837
    ),
    call("Retry t-5", "wsh jarvis dag retry t-5", "task t-5 retried", 4, 400),
    call(
        "Mark the run complete",
        "wsh jarvis complete --commit $(git rev-parse HEAD) --report C:/work/reports/t-2.md",
        "run phase marked complete; the engine takes it from here",
        6,
        520
    ),
    call("Save the follow-up", `wsh note add "Prune stale temp-dir entries"`, "added note census-wsh-never-saved", 8, 900),
    prose("Done.", T0 + 10 * S),
];

const probe = (body) =>
    `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const CARD = (key) =>
    probe(`
    const card = root.querySelector('[data-wsh-card=${JSON.stringify(key)}]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const row = card.querySelector('[data-wsh-row]');
    return {
        text: (card.innerText || '').replace(/\\s+/g, ' ').trim(),
        right: Math.round(r.right),
        rootRight: Math.round(rootBox.right),
        overflows: card.scrollWidth > card.clientWidth + 1 || (row != null && row.scrollWidth > row.clientWidth + 1),
        verb: row?.querySelector('[data-wsh-verb]')?.textContent ?? null,
        recorded: card.querySelector('[data-recorded-output]') != null,
        loadError: card.querySelector('[data-wsh-load-error]')?.textContent ?? null,
    };
`);

const openStep = (text) =>
    probe(`
    const row = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    const btn = row?.querySelector('button[aria-expanded]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
`);

const ATTENTION = probe(`
    const view = root.querySelector('[data-wsh-view="runs-attention"]');
    return view ? (view.innerText || '').replace(/\\s+/g, ' ').trim() : null;
`);

const ANSWERS = probe(`
    return [...root.querySelectorAll('[data-dag-action="answer"]')].map((el) => ({
        head: (el.querySelector('[data-answer-head]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
        picked: [...el.querySelectorAll('[data-answer-option="picked"]')].map((o) => (o.innerText || '').replace(/\\s+/g, ' ').trim()),
    }));
`);

const CARD_KEYS = probe(`return [...root.querySelectorAll('[data-wsh-card]')].map((c) => c.getAttribute('data-wsh-card'));`);

// every flat row's verb, and the text of each row
const ROWS = probe(`
    return [...root.querySelectorAll('[data-wsh-row]')].map((row) => ({
        verb: row.querySelector('[data-wsh-verb]')?.textContent ?? '',
        text: (row.innerText || '').replace(/\\s+/g, ' ').trim(),
    }));
`);

const FLAT = (keys) =>
    probe(`
    return ${JSON.stringify(keys)}.map((key) => {
        const card = root.querySelector('[data-wsh-card="' + key + '"]');
        const row = card?.querySelector('[data-wsh-row]');
        const bordered = card ? [card, ...card.querySelectorAll('*')].some((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0 || parseFloat(getComputedStyle(el).borderLeftWidth) > 0) : null;
        return { key, row: row != null, className: row?.className ?? null, bordered, text: (card?.innerText || '').replace(/\\s+/g, ' ').trim() };
    });
`);

async function show(h, host, entries, extra = {}) {
    await showAt(h, host, entries, { active: false, ...extra });
    await openFolds(h);
}

const MINUTES_OVER_59 = /(?:^|\s)(\d+)m\b/g;
const minutesOver59 = (text) => [...(text ?? "").matchAll(MINUTES_OVER_59)].map((m) => Number(m[1])).filter((n) => n > 59);

async function hostSteps(h, name, host) {
    const steps = [];
    const at = `${name} (${host.width}px)`;

    await show(h, host, chunkStatus);
    await h.shot(`cdp-shots/transcript-census-wsh-chunk-${name}.png`);
    const chunk = await h.ev(CARD("chunk-status"));
    steps.push({
        step: `${at}: a chunk known only by its title stays within the column, its title in the truncating subject, the label "Chunk active" (108)`,
        ok: chunk != null && !chunk.overflows && chunk.right <= chunk.rootRight + 1 && chunk.verb === "Chunk active",
        detail: JSON.stringify(chunk),
    });

    await show(h, host, attention, { seed: attentionSeed() });
    const opened = await h.ev(openStep(ATTENTION_CMD));
    await sleep(MOTION_MS);
    const att = await h.ev(ATTENTION);
    await h.shot(`cdp-shots/transcript-census-wsh-attention-${name}.png`);
    steps.push({
        step: `${at}: runs attention ages past an hour read in days and hours, never a minute figure over 59 (137)`,
        ok: opened === true && att != null && minutesOver59(att).length === 0 && att.includes("43d 22h") && att.includes("40d 21h"),
        detail: JSON.stringify({ opened, att, over59: minutesOver59(att) }),
    });

    await show(h, host, changes);
    await h.shot(`cdp-shots/transcript-census-wsh-changes-${name}.png`);
    const noted = await h.ev(CARD("chunk-note"));
    const done = await h.ev(CARD("chunk-status"));
    steps.push({
        step: `${at}: change cards whose initiative did not load say what changed and the load error, with no raw wsh output or initiative dump (45, 50)`,
        ok:
            noted != null &&
            done != null &&
            noted.text.includes("Noted on chunk 1") &&
            done.text.includes("Chunk done") &&
            noted.loadError != null &&
            [noted, done].every((c) => !c.recorded && !/applied to effort|effort effort|\[done\]|# Antigravity/.test(c.text)),
        detail: JSON.stringify({ noted, done }),
    });

    await show(h, host, answers, { ctx: LEAD, runEvents: answerEvents });
    await h.shot(`cdp-shots/transcript-census-wsh-answer-${name}.png`);
    const [withAsk, noAsk] = (await h.ev(ANSWERS)) ?? [];
    steps.push({
        step: `${at}: the dag answer names option 0's label and the task; one with no ask reads "option 0", and neither head is a bare id (85)`,
        ok:
            withAsk != null &&
            noAsk != null &&
            withAsk.picked.length === 1 &&
            withAsk.picked[0].includes(OPTION0) &&
            withAsk.head.includes("Answered") &&
            withAsk.head.includes("t-1") &&
            withAsk.head.includes(TASK_LABEL) &&
            noAsk.head.startsWith("Answered t-2") &&
            noAsk.picked.some((p) => p.includes("Picked option 0")),
        detail: JSON.stringify({ withAsk, noAsk }),
    });

    await show(h, host, helps);
    await h.shot(`cdp-shots/transcript-census-wsh-help-${name}.png`);
    const keys = (await h.ev(CARD_KEYS)) ?? [];
    const rows = (await h.ev(ROWS)) ?? [];
    steps.push({
        step: `${at}: help calls draw no change card (one Plan submitted, no Amended, no Noted on chunk), and no row ends on "chunk" or reads only "Amended" (14, 27, 71)`,
        ok:
            keys.filter((k) => k === "dag-submit").length === 1 &&
            !keys.includes("dag-amend") &&
            keys.filter((k) => k === "chunk-note").length === 1 &&
            rows.length > 0 &&
            rows.every((r) => !/chunk\s*$/i.test(r.verb) && r.verb !== "Amended") &&
            rows.some((r) => r.verb === "Noted on" && r.text.includes("Ship the bench later")),
        detail: JSON.stringify({ keys, rows }),
    });

    await show(h, host, oneLiners);
    await h.shot(`cdp-shots/transcript-census-wsh-oneliners-${name}.png`);
    const flat = (await h.ev(FLAT(["dag-merge", "dag-retry", "jarvis-complete", "note-add"]))) ?? [];
    steps.push({
        step: `${at}: Asked Arc to merge, Retried, Run complete and Saved a note draw the same flat row, no bordered card (71, 89)`,
        ok:
            flat.length === 4 &&
            flat.every((f) => f.row && f.bordered === false) &&
            new Set(flat.map((f) => f.className)).size === 1 &&
            flat[2].text.includes("Run complete") &&
            flat[3].text.includes("Saved a note"),
        detail: JSON.stringify(flat),
    });
    return steps;
}

export const transcriptCensusWsh = {
    name: "transcript-census-wsh",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        for (const [name, host] of Object.entries(HOSTS)) {
            steps.push(...(await hostSteps(h, name, host)));
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
