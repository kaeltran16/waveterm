// Scenario `transcript-census-steps`: the census's step-row and tool-body fixes (steprows.tsx, tooldetailbody.tsx,
// toolrenderers.tsx, recordedoutput.tsx), at the
// census's two hosts. Each fixture is trimmed from the census specimen named beside it (#N): the declined look, title
// truncation (B1), the compact answer (B2), no repeated command (B3), the 20-line body cap (C1) and its expand in place,
// the compact Tests card (C2) and its clamped failure message, the wsh fallback (C3), wrapping (C5), segment-cut paths
// (C6), the command-output gap (C8), no Open full view on a step body, status words (E4), and the user's kept ligatures
// (decision 3).

import { clearTranscript, HOSTS, openFolds, ROOT, showAt, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const S = 1000;
const MOTION_MS = 700;
// subpixel layout and rounding move a kept-in-place button by a pixel at most
const ANCHOR_SLACK_PX = 2;
const OPEN_PASSES = 2;
const FALLBACK_POLLS = 40;
const FALLBACK_POLL_MS = 150;
const ANSWER_MIN_PX = 200;
const GAP_MIN_PX = 4;

const R = `document.querySelector(${JSON.stringify(ROOT)})`;

// the projection's reason lines (decision "declined reason line")
const DECLINED_ASK = "You declined the question, so Claude stopped and waited for you.";
const DECLINED_CALL = "You declined this call, so Claude stopped and waited for you.";

const user = (text, ts) => ({ kind: "user", text, ts });
const prose = (text, ts) => ({ kind: "message", text, ts });
const bash = ({ target, command, output = "", exit = 0, ts, durationMs, outcome, error }) => ({
    kind: "action",
    verb: "ran",
    target: target ?? command,
    command,
    ts,
    durationMs,
    outcome: outcome ?? (exit === 0 ? "ok" : "fail"),
    ...(error ? { error } : {}),
    detail: { kind: "bash", command, output, exit },
});

// #4: the rejected ask, as the projection now records it
const ASK_Q =
    "What do you dislike about the current Boards talk mockup (G1-BoardsTalk, canvas boards-ask, now attached on the Agent surface)? Pick all that apply.";
const DECLINED_ASK_ENTRY = {
    kind: "action",
    verb: "asked",
    target: ASK_Q,
    ts: T0 + 2 * S,
    durationMs: 40449,
    outcome: "declined",
    error: DECLINED_ASK,
    detail: {
        kind: "ask",
        questions: [
            {
                header: "G1 dislikes",
                question: ASK_Q,
                options: [
                    { label: "Feels like a chat app", description: "The talk column reads as a generic chat sidebar bolted onto a canvas." },
                    { label: "Talk column placement", description: "A fixed right column steals canvas width." },
                    { label: "Drawing gets lost", description: "It's unclear what each reply changed on the drawing." },
                ],
                picked: [],
            },
        ],
    },
};
// #43, #123: a description long enough to truncate, with a time on the row
const TITLE_43 = "List agy models and find a recently shipped plan to replay";
const TITLE_123 = "Create a detached worktree at HEAD and junction deps";
// #142: an answered ask, the question long
const ANSWER_Q =
    "Chunks 27+35 (transcript renderer): now that each finished turn has one fold, a single test or diff card opens the whole turn. What should a finished turn do?";
const ANSWER = "Closed; cards as headers (Recommended)";

const MAIN = [
    user("Show me G1 and ask what I dislike.", T0),
    prose("Next I'll put G1 in front of you and ask what you dislike before drawing anything.", T0 + S),
    DECLINED_ASK_ENTRY,
    bash({
        target: TITLE_43,
        command: "agy models 2>&1 | head -20; echo ---; git show --stat --format='%h %s' HEAD~3..HEAD | head -40",
        output: "gemini-3-pro\ngemini-3-flash\n---\n8d7de38f6 feat(agents): transcript card facts",
        ts: T0 + 3 * S,
        durationMs: 2998,
    }),
    bash({
        target: TITLE_123,
        command: "WT=/c/Users/dev/IdeaProjects/wt-mockup-flake && git worktree add --detach $WT HEAD && cd $WT && task worktree:prepare",
        output: "Preparing worktree (detached HEAD 8d7de38f6)\nHEAD is now at 8d7de38f6 feat(agents): transcript card facts",
        ts: T0 + 4 * S,
        durationMs: 3478,
    }),
    {
        kind: "action",
        verb: "asked",
        target: ANSWER_Q,
        ts: T0 + 5 * S,
        durationMs: 108309,
        outcome: "ok",
        detail: {
            kind: "ask",
            questions: [
                {
                    header: "Card turns",
                    question: ANSWER_Q,
                    options: [{ label: ANSWER }, { label: "Open only the card's stretch" }, { label: "Keep as is" }],
                    picked: [ANSWER],
                },
            ],
        },
    },
    prose("Closing finished turns with their cards as headers.", T0 + 6 * S),
];

// E4: one row of each status word. #86 is the declined Bash; the stopped one is the transcript's last, still pending
const FAIL_CMD = "npm run check";
const DECLINED_CMD = "cd /tmp/fdl/geist && ls package/dist/fonts/geist-mono | grep -iE 'variable|\\[wght\\]'";
const BLOCKED_CMD = "npm run release > release.log";
// not a session-closing wsh call: those lay out "ok" when left pending (A6)
const STOPPED_CMD = "npm run watch";
const STATUS = [
    user("Check, then find the fonts and release.", T0),
    bash({ target: "Run the checks", command: FAIL_CMD, output: "1 error", exit: 2, ts: T0 + S, durationMs: 1200 }),
    bash({
        target: "Locate variable Geist Mono and Cascadia Mono files",
        command: DECLINED_CMD,
        exit: null,
        ts: T0 + 2 * S,
        durationMs: 4139,
        outcome: "declined",
        error: DECLINED_CALL,
    }),
    bash({
        target: "Release",
        command: BLOCKED_CMD,
        exit: null,
        ts: T0 + 3 * S,
        durationMs: 50,
        outcome: "blocked",
        error: "Refused by Arc: a release's output may not be redirected to a file",
    }),
    { kind: "action", verb: "ran", target: "Final pass", command: STOPPED_CMD, ts: T0 + 4 * S, pending: true, startedTs: T0 + 4 * S },
];

// #10: a command with no description is the row's own text
const BARE_CMD =
    'cd /c/Users/dev/IdeaProjects/waveterm/.superpowers/brainstorm/tldraw-in-arc/scan; for a in "438bee28.jsonl 2026-10-14T07:37" "572e12bb.jsonl 2026-10-20T07:02"; do node show.mjs $a 650; echo; echo =========; done';
const BARE_OUT = "C:\\Users\\dev\\.claude\\projects\\438bee28.jsonl\nH: now you make me confuse, show me the triage flow again\n---\nA: Here is the whole daily pass for one tenant and data day.";
const SKILL_NAME = "arc:verify";
const SKILL_ARGS = "check the retry budget across both callers";
// #51: 22 lines of output, two past the cap
const STATUS_51_CMD = "git status --short; gofmt -d cmd/server/main-server.go | head -30; git stash list | head -0";
const STATUS_51_OUT = [
    " M cmd/server/main-server.go",
    " M docs/orchestrator-guide.md",
    "?? pkg/wshrpc/wshserver/wshserver_memgate.go",
    "?? pkg/wshrpc/wshserver/wshserver_memgate_test.go",
    "diff cmd/server/main-server.go.orig cmd/server/main-server.go",
    "--- cmd/server/main-server.go.orig",
    "+++ cmd/server/main-server.go",
    "@@ -378,10 +378,10 @@",
    "\torchestrate.SealRunEvidenceHook = wshserver.SealDoneRunEvidenceAsync",
    "\torchestrate.LaunchLeadHook = wshserver.LaunchPlanLead",
    "\tif !snapshot {",
    "-\t\torchestrate.MarkInterruptedRuns(context.Background())    // no worker survives a restart",
    "-\t\torchestrate.ResumeInterruptedLeads(context.Background()) // nor does a dag run's lead",
    "-\t\twshserver.ResumeBrainstormSessions(context.Background()) // a brainstorm's builder check",
    "-\t\torchestrate.StartWatchdog(context.Background())          // dag advance + stall detection tick",
    "+\t\torchestrate.MarkInterruptedRuns(context.Background())          // no worker survives a restart",
    "+\t\torchestrate.ResumeInterruptedLeads(context.Background())       // nor does a dag run's lead",
    "+\t\twshserver.ResumeBrainstormSessions(context.Background())       // a brainstorm's builder check",
    "+\t\torchestrate.StartWatchdog(context.Background())                // dag advance + stall detection tick",
    "\t\tmemgate.Start(context.Background(), wshserver.ResolveMemOwner) // after StartWatchdog",
    "\t}",
    "\tagentask.AnswerHook = wshserver.RecordAskAnswered",
].join("\n");
// #9: a new file of 30 lines
const WROTE_PATH = ".superpowers/brainstorm/tldraw-in-arc/diagram-evidence.md";
const WROTE_LINES = [
    "# Would agent-written tldraw diagrams have helped this user? Evidence from local transcripts",
    "",
    "Window 2026-08-01 to 2026-11-11. All measurement ran locally; nothing was sent to a network service.",
    ...Array.from({ length: 27 }, (_, i) => `- finding ${i + 1}: a flow the user asked to see again`),
];
// #0: a go test run with six failures, the first with a FAILURE_MESSAGE the card clamps to CLAMPED_LINES lines
const TEST_NAMES = [
    ["TestDetachedTreeSetupTakesNoClaim", 262],
    ["TestFinishedWorkerClaimDoesNotHoldItsReviewer", 275],
    ["TestPlanCommandNeverWaits", 322],
    ["TestIdleFinishedWorkerNeverBlocksVerify", 337],
    ["TestLandAndBaseCheckNeverWait", 373],
    ["TestDispatchSetupNeverWaits", 398],
];
const FAILURE_MESSAGE = [
    "the gate's book holds 1 claims before the test",
    "held: run-7f3a/task-2 (worker)",
    "held since: 09:00:04",
    "released: never",
    "want: an empty book",
];
const CLAMPED_LINES = 3;
const TEST_OUT = [
    ...TEST_NAMES.flatMap(([name, line], i) => [
        `--- FAIL: ${name} (0.00s)`,
        `    memadmit_test.go:${line}: ${FAILURE_MESSAGE[0]}`,
        ...(i === 0 ? FAILURE_MESSAGE.slice(1).map((l) => `        ${l}`) : []),
    ]),
    "FAIL",
    "FAIL\tgithub.com/wavetermdev/waveterm/pkg/orchestrate\t3.135s",
    "FAIL",
].join("\n");
// #19: git show of one file's hunk
const DIFF_OUT = [
    "diff --git a/src/lib/types.ts b/src/lib/types.ts",
    "index 96be2c5..c14362e 100644",
    "--- a/src/lib/types.ts",
    "+++ b/src/lib/types.ts",
    "@@ -106,3 +106,6 @@ export interface ArticleListing {",
    "   hasSummary: boolean;",
    "   lastScore: { score: number; total: number } | null;",
    " }",
    "+",
    "+export const BOARD_KINDS: readonly Kind[] = ['system_design', 'live_coding', 'walkthrough'];",
    "+export type BoardLayer = 'ink' | 'blue';",
].join("\n");
// #8: a command, then its first output line
const GAP_CMD = "grep -o \"Markup.dc.html\" .superpowers/brainstorm/tldraw-in-arc/brainstorm.json | wc -l";
// #109: grep paths long enough to cut at either host
const SIEM = "C:/Users/dev/IdeaProjects/SIEM/src/ManagementPanel/src/main/webapp/src/components/hypotheses/";
const GREP_109 = {
    kind: "action",
    verb: "grep",
    target: "low_precision|too_many_fires",
    ts: T0 + 9 * S,
    summary: "4 matches",
    detail: {
        kind: "grep",
        pattern: "low_precision|too_many_fires",
        matches: [
            { loc: `${SIEM}FindingReport.jsx:39`, code: "  'too_many_fires'," },
            { loc: `${SIEM}FindingReport.test.tsx:525`, code: "          reason: 'low_precision'," },
            { loc: `${SIEM}InvestigationParts.jsx:10`, code: "export const LOW_PRECISION = 'low_precision';" },
        ],
    },
};
// #11: a files-only grep; the last path, from #109, is long enough to wrap at either host
const LONG_PATH = `${SIEM.replaceAll("/", "\\")}InvestigationParts.test.tsx`;
const GREP_11 = {
    kind: "action",
    verb: "grep",
    target: "drawer",
    ts: T0 + 10 * S,
    summary: "4 matches",
    detail: {
        kind: "grep",
        pattern: "drawer",
        ignoreCase: true,
        matches: [
            { loc: "", code: "cmd\\wsh\\cmd\\claude-mod\\skills\\design\\reference\\craft.md" },
            { loc: "", code: "scripts\\cdp\\scenarios-runs.mjs" },
            { loc: "", code: "frontend\\app\\view\\boards\\boardaskform.tsx" },
            { loc: "", code: LONG_PATH },
        ],
    },
};
// #37: a glob's path list
const GLOB_37 = {
    kind: "action",
    verb: "glob",
    target: "frontend/app/view/jarvis/**",
    ts: T0 + 11 * S,
    summary: "4 lines",
    detail: {
        kind: "read",
        snippet: [
            "frontend\\app\\view\\jarvis\\address.test.ts",
            "frontend\\app\\view\\jarvis\\address.ts",
            "frontend\\app\\view\\jarvis\\autonomyladder.ts",
            LONG_PATH,
        ].join("\n"),
    },
};

const BODIES = [
    user("Run the scan and check the tree.", T0),
    bash({ command: BARE_CMD, output: BARE_OUT, ts: T0 + S, durationMs: 2200 }),
    { kind: "action", verb: "skill", target: SKILL_NAME, ts: T0 + 2 * S, outcome: "ok", detail: { kind: "skill", name: SKILL_NAME, args: SKILL_ARGS } },
    bash({ command: STATUS_51_CMD, output: STATUS_51_OUT, ts: T0 + 3 * S, durationMs: 704 }),
    {
        kind: "action",
        verb: "wrote",
        target: "diagram-evidence.md",
        ts: T0 + 4 * S,
        outcome: "ok",
        detail: {
            kind: "edit",
            files: [
                {
                    path: WROTE_PATH,
                    badge: "A",
                    adds: WROTE_LINES.length,
                    dels: 0,
                    lines: WROTE_LINES.map((text, i) => ({ sign: "+", text, newNo: i + 1 })),
                },
            ],
        },
    },
    bash({ target: "Run the memadmit tests", command: "go test ./pkg/orchestrate -run Mem", output: TEST_OUT, exit: 1, ts: T0 + 5 * S, durationMs: 13724 }),
    bash({ target: "Show the types commit", command: "git show 72594bc -- src/lib/types.ts", output: DIFF_OUT, ts: T0 + 6 * S, durationMs: 1471 }),
    bash({ target: "Check remaining Markup references", command: GAP_CMD, output: "0\nquestion false\nparts false", ts: T0 + 7 * S, durationMs: 977 }),
    GREP_109,
    GREP_11,
    GLOB_37,
    prose("The scan misses pipe-style flow diagrams.", T0 + 12 * S),
];

// #108: a wsh card whose fetch fails (the dev store has no such effort) falls back to the call's recorded output
const FALLBACK_OUT = Array.from({ length: 40 }, (_, i) => `    field_${i + 1}: str = Field(description="line ${i + 1} of the goal schema")`).join("\n");
const FALLBACK = [
    user("Start the chunks.", T0),
    bash({
        command: `cd "C:/Users/dev/IdeaProjects/SIEM/src/cyber_ai/cyber_anomaly_detector" && wsh effort chunk status 7ea571f2-0000-4000-8000-00000000c108 "LLM 1: one verdict rubric" active --note "starting 1, 2, 4 together" >/dev/null; sed -n 130,246p src/services/hypothesis/investigation_goal.py`,
        output: FALLBACK_OUT,
        ts: T0 + S,
        durationMs: 1430,
    }),
    prose("Chunk 1 is active.", T0 + 2 * S),
];

// opens every fold, step and collapsed card, twice over, since an opened card can mount a closed head
async function openAll(h) {
    await openFolds(h);
    for (let i = 0; i < OPEN_PASSES; i++) {
        await h.ev(`${R}?.querySelectorAll('[data-step-head][aria-expanded="false"], [data-card-head][aria-expanded="false"]').forEach((b) => b.click())`);
        await sleep(MOTION_MS);
    }
}

// a probe over the fixture root: rowOf(text) finds a step by its head's text, token(name) the computed colour of a
// theme token, mono the computed mono family
const probe = (body) => `(() => {
    const root = ${R};
    if (!root) return null;
    const rowOf = (t) => [...root.querySelectorAll('[data-step]')].find((s) => (s.querySelector('[data-step-head]')?.textContent ?? '').includes(t));
    const sample = (cls, style) => { const s = document.createElement('span'); s.className = cls; Object.assign(s.style, style); root.appendChild(s); const cs = getComputedStyle(s); const out = { color: cs.color, font: cs.fontFamily }; s.remove(); return out; };
    const token = (name) => sample('', { color: 'var(--color-' + name + ')' }).color;
    const mono = sample('font-mono', {}).font;
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    ${body}
})()`;

function declinedSteps(s, label) {
    return [
        {
            step: `[${label}] #4 declined ask: a "declined" word in the muted token, the Ban square, its reason muted and not mono, no error block`,
            ok:
                s != null &&
                s.status === "declined" &&
                s.word === "declined" &&
                s.wordColor === s.muted &&
                s.ban === true &&
                s.note === DECLINED_ASK &&
                s.noteColor === s.muted &&
                s.noteFont !== s.mono &&
                s.errors === 0,
            detail: JSON.stringify(s),
        },
    ];
}

const DECLINED_STATE = probe(`
    const row = rowOf('What do you dislike');
    const panel = row?.querySelector('[data-tool-panel]');
    const note = panel?.querySelector('[data-tool-note]');
    const word = row?.querySelector('[data-step-head] [data-step-word]');
    return row ? {
        status: row.getAttribute('data-step-status'),
        word: word?.textContent ?? null,
        wordColor: word ? getComputedStyle(word).color : null,
        ban: !!note?.querySelector('[role="img"][aria-label="Declined"]'),
        note: note?.textContent ?? null,
        noteColor: note ? getComputedStyle(note).color : null,
        noteFont: note ? getComputedStyle(note).fontFamily : null,
        errors: panel ? panel.querySelectorAll('[data-tool-error]').length : null,
        muted: token('muted'),
        mono,
    } : null;
`);

// B1: the title cuts with an ellipsis and ends left of the row's facts, which keep their width
const TITLES_STATE = probe(`
    return ${JSON.stringify(["What do you dislike", TITLE_43, TITLE_123])}.map((t) => {
        const row = rowOf(t);
        const title = row?.querySelector('[data-step-title]');
        const facts = row?.querySelector('[data-step-head] [data-step-word], [data-step-head] [data-step-duration]');
        return {
            t: t.slice(0, 20),
            overflow: title ? getComputedStyle(title).textOverflow : null,
            cut: title ? title.scrollWidth > title.clientWidth : null,
            right: rect(title)?.right ?? null,
            factsLeft: rect(facts)?.left ?? null,
            factsWhole: facts ? facts.scrollWidth <= facts.clientWidth : null,
        };
    });
`);

const ANSWER_STATE = probe(`
    const a = rowOf('Chunks 27+35')?.querySelector('[data-step-answer]');
    return a ? { width: Math.round(rect(a).width), text: a.textContent } : null;
`);

async function mainSteps(h, label, host) {
    await showAt(h, host, MAIN);
    await openAll(h);
    const declined = await h.ev(DECLINED_STATE);
    const titles = await h.ev(TITLES_STATE);
    const answer = await h.ev(ANSWER_STATE);
    await h.shot(`cdp-shots/transcript-census-steps-main-${label}.png`);
    return [
        ...declinedSteps(declined, label),
        {
            step: `[${label}] #4/#43/#123 B1: each title ends with an ellipsis left of its facts, and the facts keep their width`,
            ok:
                Array.isArray(titles) &&
                titles.length === 3 &&
                titles.every((t) => t.overflow === "ellipsis" && t.right != null && t.factsLeft != null && t.right <= t.factsLeft + 0.5 && t.factsWhole === true) &&
                // at least the ask's long question is actually cut
                titles.some((t) => t.cut === true),
            detail: JSON.stringify(titles),
        },
        {
            step: `[${label}] #142 B2: the ask's answer takes the row's width (over ${ANSWER_MIN_PX}px)`,
            ok: answer != null && answer.width > ANSWER_MIN_PX && answer.text === ANSWER,
            detail: JSON.stringify(answer),
        },
    ];
}

// E4: each row's one status word and its tone
const STATUS_STATE = probe(`
    const rows = { fail: 'Run the checks', declined: 'Locate variable Geist', blocked: 'Release', stopped: 'Final pass' };
    const out = { error: token('error'), warning: token('warning'), muted: token('muted') };
    for (const [k, t] of Object.entries(rows)) {
        const row = rowOf(t);
        const head = row?.querySelector('[data-step-head]');
        const words = head ? [...head.querySelectorAll('[data-step-word]')] : [];
        out[k] = row ? {
            status: row.getAttribute('data-step-status'),
            words: words.map((w) => w.textContent),
            color: words[0] ? getComputedStyle(words[0]).color : null,
            repeats: head ? (head.textContent.match(new RegExp(k, 'g')) ?? []).length : null,
        } : null;
    }
    const note = rowOf('Locate variable Geist')?.querySelector('[data-tool-note]');
    out.declinedNote = note?.textContent ?? null;
    out.declinedErrors = rowOf('Locate variable Geist')?.querySelectorAll('[data-tool-error]').length ?? null;
    return out;
`);

async function statusSteps(h, label, host) {
    await showAt(h, host, STATUS);
    await openAll(h);
    const s = await h.ev(STATUS_STATE);
    await h.shot(`cdp-shots/transcript-census-steps-status-${label}.png`);
    const one = (r, status, color) => r != null && r.status === status && r.words.length === 1 && r.color === color;
    return [
        {
            step: `[${label}] E4: failed reads in the error token, stopped in the warning token, blocked and declined in the muted token, one word each`,
            ok:
                s != null &&
                one(s.fail, "fail", s.error) &&
                s.fail.words[0] === "exit 2" &&
                one(s.stopped, "stopped", s.warning) &&
                one(s.blocked, "blocked", s.muted) &&
                one(s.declined, "declined", s.muted),
            detail: JSON.stringify(s),
        },
        {
            step: `[${label}] #86 the declined Bash names its status once, and its reason is the projection's line, not an error block`,
            ok:
                s?.declined?.repeats === 1 &&
                s.stopped?.repeats === 1 &&
                s.blocked?.repeats === 1 &&
                s.declinedNote === DECLINED_CALL &&
                s.declinedErrors === 0,
            detail: JSON.stringify({ declined: s?.declined, note: s?.declinedNote, errors: s?.declinedErrors }),
        },
    ];
}

const BODIES_STATE = probe(`
    const panelOf = (t) => rowOf(t)?.querySelector('[data-tool-panel]');
    const lastOf = (el, sel) => { const all = el ? el.querySelectorAll(sel) : []; return all.length ? all[all.length - 1] : null; };
    const clipped = (box) => box ? box.scrollHeight > box.clientHeight + 1 : null;

    const bare = panelOf('for a in');
    const skill = panelOf(${JSON.stringify(SKILL_NAME)});
    const p51 = panelOf('git status --short');
    const more51 = p51?.querySelector('[data-more-lines]');
    const wrote = panelOf('diagram-evidence.md');
    const moreWrote = wrote?.querySelector('[data-more-lines]');
    const lastWrote = lastOf(wrote, '[data-line-text]');
    const testRow = rowOf('Run the memadmit tests');
    const test = testRow?.querySelector('[data-tool-card="test"]');
    const firstFail = test?.querySelector('[data-test-failure]');
    const gapPanel = panelOf('Check remaining Markup');
    const cmd = gapPanel?.querySelector('[data-bash-command]');
    const out = gapPanel?.querySelector('[data-bash-output]');
    const paths = [...(panelOf('low_precision')?.querySelectorAll('[data-grep-file] [data-panel-path]') ?? [])].map((p) => ({
        text: p.querySelector('bdi')?.textContent ?? null,
        fits: p.scrollWidth <= p.clientWidth + 1,
    }));
    const longLine = [...(panelOf('drawer')?.querySelectorAll('[data-line-text]') ?? [])].find((l) => l.textContent === ${JSON.stringify(LONG_PATH)});
    const lines = (() => {
        if (!longLine?.firstChild) return null;
        const r = document.createRange();
        r.selectNodeContents(longLine);
        const rects = [...r.getClientRects()].filter((x) => x.width > 0);
        return rects.length ? { n: rects.length, first: Math.round(rects[0].left), last: Math.round(rects[rects.length - 1].left) } : null;
    })();
    const globLine = lastOf(panelOf('frontend/app/view/jarvis'), '[data-line-text]');
    const code = wrote?.querySelector('[data-line-text]');
    return {
        bare: bare ? { first: bare.textContent.slice(0, 40), command: !!bare.querySelector('[data-bash-command]'), head: rowOf('for a in')?.querySelector('[data-step-head]')?.textContent ?? null } : null,
        skill: skill ? { text: skill.textContent, nameShown: skill.textContent.includes(${JSON.stringify(SKILL_NAME)}) } : null,
        p51: p51 ? { more: more51?.textContent ?? null, outLines: p51.querySelector('[data-bash-output]')?.textContent.split('\\n').length ?? null, clipped: clipped(p51), moreIn: more51 ? rect(more51).bottom <= rect(p51).bottom : null } : null,
        wrote: wrote ? { more: moreWrote?.textContent ?? null, lines: wrote.querySelectorAll('[data-line-text]').length, lastAbove: lastWrote && moreWrote ? rect(lastWrote).bottom <= rect(moreWrote).top + 1 : null, clipped: clipped(wrote) } : null,
        test: test ? { failures: test.querySelectorAll('[data-test-failure]').length, clipped: clipped(test), lastIn: rect(lastOf(test, '[data-test-failure]')).bottom <= rect(test).bottom + 1 } : null,
        names: firstFail ? { name: Math.round(rect(firstFail.querySelector('[data-test-name]')).width), where: Math.round(rect(firstFail.querySelector('[data-test-where]')).width) } : null,
        fullViews: root.querySelectorAll('button[aria-label="Open full view"]').length,
        gap: cmd && out ? Math.round(rect(out).top - rect(cmd).bottom) : null,
        paths,
        wrap: longLine ? { overflowWrap: getComputedStyle(longLine).overflowWrap, ...lines } : null,
        glob: globLine ? { indent: getComputedStyle(globLine).textIndent, pad: getComputedStyle(globLine).paddingLeft } : null,
        ligatures: { command: cmd ? getComputedStyle(cmd).fontVariantLigatures : null, code: code ? getComputedStyle(code).fontVariantLigatures : null },
    };
`);

async function bodySteps(h, label, host) {
    await showAt(h, host, BODIES);
    await openAll(h);
    const s = await h.ev(BODIES_STATE);
    await h.shot(`cdp-shots/transcript-census-steps-bodies-${label}.png`);
    const segment = (t) => t != null && (t.startsWith(SIEM) || /^…[\\/]/.test(t));
    return [
        {
            step: `[${label}] #10 B3: a command with no description opens to its output, not the command again; the row shows it whole`,
            ok:
                s?.bare != null &&
                s.bare.command === false &&
                !s.bare.first.startsWith("$") &&
                s.bare.first.startsWith("C:\\Users\\dev") &&
                (s.bare.head ?? "").includes("cd /c/Users/dev/IdeaProjects"),
            detail: JSON.stringify(s?.bare),
        },
        {
            step: `[${label}] B3: a Skill body is its arguments, not its header again`,
            ok: s?.skill != null && s.skill.nameShown === false && s.skill.text.includes(SKILL_ARGS),
            detail: JSON.stringify(s?.skill),
        },
        {
            step: `[${label}] #51/#9/#0 C1: a capped body shows 20 whole lines then "N more lines", nothing clipped`,
            ok:
                s?.p51 != null &&
                s.p51.more === "2 more lines" &&
                s.p51.outLines === 20 &&
                s.p51.clipped === false &&
                s.p51.moreIn === true &&
                s.wrote != null &&
                s.wrote.more === "11 more lines" &&
                s.wrote.lines === 19 &&
                s.wrote.lastAbove === true &&
                s.wrote.clipped === false &&
                s.test != null &&
                s.test.failures === TEST_NAMES.length &&
                s.test.clipped === false &&
                s.test.lastIn === true,
            detail: JSON.stringify({ p51: s?.p51, wrote: s?.wrote, test: s?.test }),
        },
        {
            step: `[${label}] #0 C2: the Tests card gives the test name more width than file:line`,
            ok: s?.names != null && s.names.name > s.names.where,
            detail: JSON.stringify(s?.names),
        },
        {
            step: `[${label}] no step body offers Open full view: not a command, a write, the Tests or git diff card`,
            ok: s?.fullViews === 0,
            detail: `fullViews=${s?.fullViews}`,
        },
        {
            step: `[${label}] #8 C8: a gap between the command and its first output line`,
            ok: s?.gap != null && s.gap >= GAP_MIN_PX,
            detail: `gap=${s?.gap}`,
        },
        {
            step: `[${label}] #109 C6: each grep path starts at a segment and fits its header`,
            ok: Array.isArray(s?.paths) && s.paths.length === 3 && s.paths.every((p) => segment(p.text) && p.fits),
            detail: JSON.stringify(s?.paths),
        },
        {
            step: `[${label}] #11/#37 C5: a wrapped path breaks as break-word and its continuation hangs right of its first line`,
            ok:
                s?.wrap != null &&
                s.wrap.overflowWrap === "break-word" &&
                s.wrap.n >= 2 &&
                s.wrap.last > s.wrap.first &&
                s.glob != null &&
                parseFloat(s.glob.indent) < 0 &&
                parseFloat(s.glob.pad) > 0,
            detail: JSON.stringify({ wrap: s?.wrap, glob: s?.glob }),
        },
        {
            step: `[${label}] decision 3 (ligatures kept): a command line and a code body keep font-variant-ligatures other than none`,
            ok:
                s?.ligatures?.command != null &&
                s.ligatures.command !== "none" &&
                s.ligatures.code != null &&
                s.ligatures.code !== "none",
            detail: JSON.stringify(s?.ligatures),
        },
    ];
}

// C6 on a narrowing box: the grep paths fit whole in a wide host, then the host narrows to its own width; each path
// must cut at a segment again, not fall back to a mid-word cut
const WIDE_PX = 1400;
const PATHS_STATE = probe(`
    const panel = rowOf('low_precision')?.querySelector('[data-tool-panel]');
    return [...(panel?.querySelectorAll('[data-grep-file] [data-panel-path]') ?? [])].map((p) => ({
        text: p.querySelector('bdi')?.textContent ?? null,
        fits: p.scrollWidth <= p.clientWidth + 1,
    }));
`);

async function narrowedPathStep(h, label, host) {
    await showAt(h, host, BODIES, { width: WIDE_PX });
    await openAll(h);
    const wide = await h.ev(PATHS_STATE);
    await h.ev(`${R}.style.width = '${host.width}px'`);
    await sleep(MOTION_MS);
    const narrow = await h.ev(PATHS_STATE);
    const whole = (t) => t != null && t.startsWith(SIEM);
    const segment = (t) => t != null && /^…[\\/]/.test(t);
    return {
        step: `[${label}] C6: grep paths that fit whole, narrowed to ${host.width}px, cut at a segment again`,
        ok:
            Array.isArray(wide) &&
            wide.length === 3 &&
            wide.every((p) => whole(p.text)) &&
            Array.isArray(narrow) &&
            narrow.length === 3 &&
            narrow.every((p) => segment(p.text) && p.fits),
        detail: JSON.stringify({ wide, narrow }),
    };
}

const FALLBACK_STATE = probe(`
    const f = root.querySelector('[data-wsh-load-failure]');
    const box = f?.querySelector('[data-wsh-load-output]');
    if (!box) return f ? { failure: true, box: false } : null;
    return {
        more: box.querySelector('[data-more-lines]')?.textContent ?? null,
        lines: box.querySelector('[data-recorded-output]')?.textContent.split('\\n').length ?? null,
        full: !!f.querySelector('button[aria-label="Open full view"]'),
        // capped by line count, so a 20-line cap that wraps in a narrow card is still whole, never clipped
        clipped: box.scrollHeight > box.clientHeight + 1,
        bordered: getComputedStyle(box).borderTopWidth !== '0px',
    };
`);

async function fallbackStep(h, label, host) {
    await showAt(h, host, FALLBACK);
    await openAll(h);
    let s = null;
    for (let i = 0; i < FALLBACK_POLLS && !(s = await h.ev(FALLBACK_STATE))?.more; i++) await sleep(FALLBACK_POLL_MS);
    await h.ev(probe(`root.querySelector('[data-wsh-load-failure]')?.scrollIntoView({ block: "center" }); return true;`));
    await sleep(200);
    await h.shot(`cdp-shots/transcript-census-steps-fallback-${label}.png`);
    return {
        step: `[${label}] #108 C3: the wsh fallback's output is boxed, capped at 20 whole lines with "20 more lines", nothing clipped, and no Open full view`,
        ok:
            s != null &&
            s.more === "20 more lines" &&
            s.lines === 20 &&
            s.full === false &&
            s.bordered === true &&
            s.clipped === false,
        detail: JSON.stringify(s),
    };
}

const EXPAND_STATE = probe(`
    const panel = rowOf('git status --short')?.querySelector('[data-tool-panel]');
    const test = rowOf('Run the memadmit tests')?.querySelector('[data-tool-card="test"]');
    const btn = (el) => el?.querySelector('[data-more-lines]');
    const message = test?.querySelector('[data-test-failure] [data-test-message]');
    return {
        body: panel ? {
            lines: panel.querySelector('[data-bash-output]')?.textContent.split(String.fromCharCode(10)).length ?? null,
            button: btn(panel)?.textContent ?? null,
            expanded: btn(panel)?.getAttribute('aria-expanded') ?? null,
        } : null,
        test: test ? {
            failures: test.querySelectorAll('[data-test-failure]').length,
            message: message?.textContent ?? null,
            button: btn(test)?.textContent ?? null,
            expanded: btn(test)?.getAttribute('aria-expanded') ?? null,
        } : null,
    };
`);

const clickMore = (text) => probe(`rowOf(${JSON.stringify(text)})?.querySelector('[data-more-lines]')?.click(); return true;`);

// C1 expanded: "N more lines" lifts the cap in place and reads "Show less", which puts it back; the Tests card's
// clamped message expands whole the same way
async function expandSteps(h, label, host) {
    await showAt(h, host, BODIES);
    await openAll(h);
    const before = await h.ev(EXPAND_STATE);
    await h.ev(clickMore("git status --short"));
    await h.ev(clickMore("Run the memadmit tests"));
    await sleep(MOTION_MS);
    const open = await h.ev(EXPAND_STATE);
    await h.ev(probe(`rowOf('Run the memadmit tests')?.scrollIntoView({ block: "start" }); return true;`));
    await sleep(200);
    await h.shot(`cdp-shots/transcript-census-steps-expanded-${label}.png`);
    // Show less pressed with its button low in the viewport, as a reader at the end of a long body presses it
    await h.ev(probe(`rowOf('git status --short')?.querySelector('[data-more-lines]')?.scrollIntoView({ block: "end" }); return true;`));
    await sleep(200);
    const lessAt = await h.ev(probe(`return rect(rowOf('git status --short')?.querySelector('[data-more-lines]'))?.top ?? null;`));
    await h.ev(clickMore("git status --short"));
    await sleep(MOTION_MS);
    const lessThen = await h.ev(probe(`return rect(rowOf('git status --short')?.querySelector('[data-more-lines]'))?.top ?? null;`));
    await h.ev(clickMore("Run the memadmit tests"));
    await sleep(MOTION_MS);
    const after = await h.ev(EXPAND_STATE);
    const whole = FAILURE_MESSAGE.join(NL);
    const clamped = FAILURE_MESSAGE.slice(0, CLAMPED_LINES).join(NL);
    const hiddenLines = FAILURE_MESSAGE.length - CLAMPED_LINES;
    return [
        {
            step: `[${label}] #51 C1 expand: "2 more lines" shows all 22 lines in place and reads "Show less"; Show less cuts back to 20`,
            ok:
                before?.body?.lines === 20 &&
                before.body.button === "2 more lines" &&
                before.body.expanded === "false" &&
                open?.body?.lines === 22 &&
                open.body.button === "Show less" &&
                open.body.expanded === "true" &&
                after?.body?.lines === 20 &&
                after.body.button === "2 more lines",
            detail: JSON.stringify({ before: before?.body, open: open?.body, after: after?.body }),
        },
        {
            step: `[${label}] #51 C1 Show less keeps its button where the reader pressed it (within ${ANCHOR_SLACK_PX}px)`,
            ok: lessAt != null && lessThen != null && Math.abs(lessThen - lessAt) <= ANCHOR_SLACK_PX,
            detail: JSON.stringify({ lessAt, lessThen }),
        },
        {
            step: `[${label}] #0 C2 expand: a multi-line failure is clamped to ${CLAMPED_LINES} lines with "${hiddenLines} more lines"; expanded it shows whole, Show less clamps it again`,
            ok:
                before?.test?.message === clamped &&
                before.test.button === `${hiddenLines} more lines` &&
                before.test.failures === TEST_NAMES.length &&
                open?.test?.message === whole &&
                open.test.button === "Show less" &&
                open.test.expanded === "true" &&
                open.test.failures === TEST_NAMES.length &&
                after?.test?.message === clamped &&
                after.test.button === `${hiddenLines} more lines`,
            detail: JSON.stringify({ before: before?.test, open: open?.test, after: after?.test }),
        },
    ];
}

export const transcriptCensusSteps = {
    name: "transcript-census-steps",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        for (const [label, host] of Object.entries(HOSTS)) {
            steps.push(...(await mainSteps(h, label, host)));
            steps.push(...(await statusSteps(h, label, host)));
            steps.push(...(await bodySteps(h, label, host)));
            steps.push(await narrowedPathStep(h, label, host));
            steps.push(await fallbackStep(h, label, host));
            steps.push(...(await expandSteps(h, label, host)));
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
