// Scenario `transcript-census-projection`: the census's projection fixes (transcriptprojection.ts). Raw Claude Code
// records, trimmed from the census specimens, go through the tree's own projectTranscript in the page (projectInPage)
// and draw at both census hosts:
// - a PowerShell call (#143) is a command: its row opens to the command and its output
// - a task-notification's summary (#75) reads its XML entities decoded
// - a compaction summary (#16) loses Claude Code's <system-reminder> block, so its markdown renders
// - a failed Edit (#51) shows no +/- counts
// - a question the user declined (#4) reads "declined" with its reason line, and its fold counts no failure
// Raw pi records go the same way through the tree's own projectPiTranscript (projectPiInPage):
// - an extension tool reads as readableVerb's words, not its raw name
// - a bash call that exited 2 shows exit 2, and pi's status line is not in its output
// - a failed edit shows no +/- counts
// - a `!` command draws as a command row with its exit code, and a `!!` one says it was kept out of the model's context

import {
    clearTranscript,
    HOSTS,
    openFolds,
    projectInPage,
    projectPiInPage,
    ROOT,
    showAt,
    waitSeam,
} from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLLS = 25;
const POLL_MS = 100;
const R = `document.querySelector(${JSON.stringify(ROOT)})`;

const T0 = Date.UTC(2026, 10, 17, 5, 14, 0);
const S = 1000;
const at = (s) => new Date(T0 + s * S).toISOString();

const PS_DESCRIPTION = "Inspect run-related env vars and list runs";
const PS_COMMAND = "Get-ChildItem env: | Where-Object { $_.Name -match 'ARC|RUN' } | Format-Table -AutoSize";
const PS_OUTPUT_LINE = "ARC_RUN_AGENT";
const EDIT_FILE = "main-server.go";
const QUESTION = "What do you dislike about the current Boards talk mockup?";
const DECLINED_LINE = "You declined the question, so Claude stopped and waited for you.";
const REFUSAL = "The user doesn't want to proceed";
const NOTIFICATION_COMMAND = 'mkdir -p out && node final-verify.mjs agent-rendered 2>&1';

const L = (o) => JSON.stringify(o);
const prompt = (text, s) => L({ type: "user", timestamp: at(s), message: { role: "user", content: text } });
const reply = (text, s) => L({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } });
const use = (id, name, input, s) =>
    L({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, s, extra = {}) =>
    L({
        type: "user",
        timestamp: at(s),
        ...extra,
        message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] },
    });

const RAW = [
    prompt("Check the run environment and fix the restart comment.", 0),
    // #143
    use("p1", "PowerShell", { command: PS_COMMAND, description: PS_DESCRIPTION }, 2),
    result(
        "p1",
        `Exit code 1\nName                               Value\r\n----                               -----\r\n${PS_OUTPUT_LINE}                      1\r\n\r\nError: C:\\Temp\\verify is in no Arc project: register it in the cockpit, or pass --channel`,
        5
    ),
    // #51
    use(
        "e1",
        "Edit",
        {
            file_path: `C:\\wt\\cmd\\server\\${EDIT_FILE}`,
            old_string: "\t\torchestrate.StartWatchdog(ctx)\n\t\tmemgate.Start(ctx)",
            new_string: "\t\t// after StartWatchdog\n\t\torchestrate.StartWatchdog(ctx)\n\t\tmemgate.Start(ctx)",
        },
        7
    ),
    result("e1", "<tool_use_error>String to replace not found in file.\nString: \t\torchestrate.StartWatchdog(ctx)</tool_use_error>", 8),
    reply("The run is in no Arc project, and the edit missed; I'll re-read the file.", 9),
    // #75
    L({
        type: "user",
        timestamp: at(20),
        message: {
            content: [
                "<task-notification>",
                "<task-id>b1ggaf2wk</task-id>",
                `<summary>Background command "${NOTIFICATION_COMMAND.replaceAll("&", "&amp;").replaceAll(">", "&gt;")}" completed (exit code 0)</summary>`,
                "<status>completed</status>",
                "</task-notification>",
            ].join("\n"),
        },
    }),
    // #16
    L({ type: "system", subtype: "compact_boundary", timestamp: at(30), compactMetadata: { trigger: "manual", preTokens: 85651, postTokens: 16086 } }),
    L({
        type: "user",
        isCompactSummary: true,
        timestamp: at(30),
        message: {
            content:
                "This session is being continued from a previous conversation that ran out of context.\n\n" +
                "<system-reminder>\n<tools-used-before-summary>Bash, Grep</tools-used-before-summary>\n</system-reminder>\n" +
                "Summary:\n1. Primary Request and Intent:\n   - **Spec:** docs/superpowers/specs/slim.md\n   - **Plan:** docs/superpowers/plans/bench.md\n\n" +
                "## Pending\n- Re-run the bench",
        },
    }),
    prompt("Show me the mockup and ask what to change.", 40),
    // #4
    use(
        "q1",
        "AskUserQuestion",
        {
            questions: [
                {
                    question: QUESTION,
                    header: "G1 dislikes",
                    multiSelect: true,
                    options: [{ label: "Feels like a chat app" }, { label: "Too dense" }],
                },
            ],
        },
        42
    ),
    result(
        "q1",
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        50,
        { toolUseResult: "User rejected tool use", toolDenialKind: "user-rejected" }
    ),
    reply("Understood, I'll wait for you.", 51),
];

const PI_EXT_TOOL = "fetch_docs_page";
const PI_EXT_TITLE = "Fetch docs page";
const PI_EXT_TARGET = "install.md";
const PI_BASH_COMMAND = "make lint";
const PI_EXIT_STATUS = "Command exited with code 2";
const PI_EDIT_FILE = "relay.go";
const PI_BANG = "git status --short";
const PI_BANG_EXIT = 128;
const PI_BANGBANG = "ls dist";

// pi v3 records chain by parentId; each record here is the previous one's child
function piRecords() {
    let parent = null;
    let n = 0;
    const rec = (s, body) => {
        const id = `p${++n}`;
        const line = L({ type: "message", id, parentId: parent, timestamp: at(s), ...body });
        parent = id;
        return line;
    };
    const call = (id, name, args, s) =>
        rec(s, { message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
    const res = (id, name, text, isError, s) =>
        rec(s, { message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError } });
    const bashExec = (command, output, exitCode, s, extra = {}) =>
        rec(s, {
            message: { role: "bashExecution", command, output, exitCode, cancelled: false, truncated: false, timestamp: T0 + s * S, ...extra },
        });
    return [
        L({ type: "session", version: 3, id: "pi-census", timestamp: at(0), cwd: "C:\\wt" }),
        rec(1, { message: { role: "user", content: "Read the install guide, lint, and fix the relay." } }),
        call("x1", PI_EXT_TOOL, { path: `docs/guide/${PI_EXT_TARGET}` }, 2),
        res("x1", PI_EXT_TOOL, "# Install\nRun the installer.", false, 3),
        call("b1", "bash", { command: PI_BASH_COMMAND }, 4),
        res("b1", "bash", `relay.go:12: unused variable\n\n${PI_EXIT_STATUS}`, true, 6),
        call("e1", "edit", { path: `C:\\wt\\pkg\\${PI_EDIT_FILE}`, edits: [{ oldText: "x := 1\n", newText: "" }] }, 7),
        res("e1", "edit", `Could not find the exact text in C:\\wt\\pkg\\${PI_EDIT_FILE}.`, true, 8),
        rec(9, { message: { role: "assistant", content: [{ type: "text", text: "The edit missed; I'll re-read the file." }] } }),
        bashExec(PI_BANG, "fatal: not a git repository\n", PI_BANG_EXIT, 20),
        bashExec(PI_BANGBANG, "app.js\napp.css\n", 0, 25, { excludeFromContext: true }),
    ];
}

const poll = async (h, expr) => {
    for (let i = 0; i < POLLS; i++) {
        if (await h.ev(expr)) return true;
        await sleep(POLL_MS);
    }
    return false;
};

// the step row whose text holds `needle`, as an expression
const stepWith = (needle) =>
    `[...(${R}?.querySelectorAll('[data-step]') ?? [])].find((s) => s.textContent.includes(${JSON.stringify(needle)}))`;

// opens the step's body by its head when it is closed; true when it is open
async function openStep(h, needle) {
    await h.ev(`(() => {
        const head = ${stepWith(needle)}?.querySelector('[data-step-head][aria-expanded="false"]');
        head?.click();
    })()`);
    return poll(h, `${stepWith(needle)}?.querySelector('[data-step-head]')?.getAttribute('aria-expanded') === 'true'`);
}

async function hostSteps(h, name, host, entries) {
    await showAt(h, host, entries);
    // read the folds before they open: the turn of the declined question counts no failure
    const folds = await h.ev(`[...(${R}?.querySelectorAll('[data-fold]') ?? [])].map((f) => f.textContent)`);
    await openFolds(h);
    const steps = [];

    const psOpen = await openStep(h, PS_DESCRIPTION);
    const ps = await h.ev(`(() => {
        const step = ${stepWith(PS_DESCRIPTION)};
        const panel = step?.querySelector('[data-tool-panel]');
        return panel ? { status: step.dataset.stepStatus, text: panel.textContent } : null;
    })()`);
    steps.push({
        step: `${name}: the PowerShell row opens to its command and its output`,
        ok: psOpen && ps != null && ps.text.includes(PS_COMMAND) && ps.text.includes(PS_OUTPUT_LINE),
        detail: JSON.stringify({ psOpen, status: ps?.status, text: ps?.text.slice(0, 300) }),
    });

    const note = await h.ev(`${R}?.querySelector('[data-task-notification]')?.textContent ?? null`);
    steps.push({
        step: `${name}: the notification summary reads its entities decoded`,
        ok: note != null && !note.includes("&amp;") && !note.includes("&gt;") && note.includes(NOTIFICATION_COMMAND),
        detail: JSON.stringify(note),
    });

    await h.ev(`${R}?.querySelector('[data-compaction] button[aria-expanded="false"]')?.click()`);
    const summaryOpen = await poll(h, `!!${R}?.querySelector('[data-compaction] .agent-md, [data-compaction] strong')`);
    const compaction = await h.ev(`(() => {
        const c = ${R}?.querySelector('[data-compaction]');
        return c ? { text: c.innerText, strong: c.querySelectorAll('strong').length, headings: c.querySelectorAll('h1,h2,h3,h4').length } : null;
    })()`);
    steps.push({
        step: `${name}: the compaction summary has no system-reminder text and renders its markdown`,
        ok:
            summaryOpen &&
            compaction != null &&
            !/system-reminder|tools-used-before-summary/.test(compaction.text) &&
            !compaction.text.includes("**") &&
            !compaction.text.includes("##") &&
            compaction.strong > 0 &&
            compaction.headings > 0,
        detail: JSON.stringify({ summaryOpen, ...compaction, text: compaction?.text.slice(0, 300) }),
    });

    const edit = await h.ev(`(() => {
        const step = ${stepWith(EDIT_FILE)};
        return step ? { status: step.dataset.stepStatus, counts: step.querySelectorAll('[class*="text-diff-added"], [class*="text-diff-removed"]').length, head: step.querySelector('[data-step-head]')?.textContent } : null;
    })()`);
    steps.push({
        step: `${name}: the failed edit row shows no +/- counts`,
        ok: edit != null && edit.status === "fail" && edit.counts === 0,
        detail: JSON.stringify(edit),
    });

    const askOpen = await openStep(h, QUESTION);
    const ask = await h.ev(`(() => {
        const step = ${stepWith(QUESTION)};
        return step ? { status: step.dataset.stepStatus, text: step.textContent } : null;
    })()`);
    const askFold = (folds ?? []).find((f) => f.includes("asked"));
    steps.push({
        step: `${name}: the declined question reads declined with its reason line, and its fold counts no failure`,
        ok:
            askOpen &&
            ask != null &&
            ask.status === "declined" &&
            ask.text.includes(DECLINED_LINE) &&
            !ask.text.includes(REFUSAL) &&
            askFold != null &&
            !askFold.includes("failed"),
        detail: JSON.stringify({ askOpen, status: ask?.status, text: ask?.text.slice(0, 300), folds }),
    });
    await h.shot(`cdp-shots/transcript-census-projection-${name}.png`);
    return steps;
}

// the `!` row whose command is `command`, as an expression
const shellWith = (command) =>
    `[...(${R}?.querySelectorAll('[data-shell-run]') ?? [])].find((r) => r.querySelector('[data-shell-command]')?.textContent === ${JSON.stringify(command)})`;

async function piHostSteps(h, name, host, entries) {
    await showAt(h, host, entries);
    await openFolds(h);
    const steps = [];

    const ext = await h.ev(`(() => {
        const step = ${stepWith(PI_EXT_TARGET)};
        return step ? { title: step.querySelector('[data-step-title]')?.textContent, text: step.textContent } : null;
    })()`);
    steps.push({
        step: `pi ${name}: the extension tool reads as words`,
        ok: ext != null && ext.title?.trim() === PI_EXT_TITLE && !ext.text.includes(PI_EXT_TOOL),
        detail: JSON.stringify(ext),
    });

    const bashOpen = await openStep(h, PI_BASH_COMMAND);
    const bash = await h.ev(`(() => {
        const step = ${stepWith(PI_BASH_COMMAND)};
        return step ? { word: step.querySelector('[data-step-word]')?.textContent, panel: step.querySelector('[data-tool-panel]')?.textContent } : null;
    })()`);
    steps.push({
        step: `pi ${name}: the bash row shows exit 2, and pi's status line is not in its output`,
        ok: bashOpen && bash != null && bash.word === "exit 2" && bash.panel != null && !bash.panel.includes(PI_EXIT_STATUS),
        detail: JSON.stringify({ bashOpen, ...bash }),
    });

    const edit = await h.ev(`(() => {
        const step = ${stepWith(PI_EDIT_FILE)};
        return step ? { status: step.dataset.stepStatus, counts: step.querySelectorAll('[class*="text-diff-added"], [class*="text-diff-removed"]').length } : null;
    })()`);
    steps.push({
        step: `pi ${name}: the failed edit row shows no +/- counts`,
        ok: edit != null && edit.status === "fail" && edit.counts === 0,
        detail: JSON.stringify(edit),
    });

    const bang = await h.ev(`(() => {
        const row = ${shellWith(PI_BANG)};
        return row ? { exit: row.querySelector('[data-shell-mark="exit"]')?.textContent ?? null, excluded: !!row.querySelector('[data-shell-excluded]') } : null;
    })()`);
    steps.push({
        step: `pi ${name}: the \`!\` command draws as a command row with its exit code`,
        ok: bang != null && bang.exit === `exit ${PI_BANG_EXIT}` && !bang.excluded,
        detail: JSON.stringify(bang),
    });

    const bangBang = await h.ev(`(() => {
        const row = ${shellWith(PI_BANGBANG)};
        return row ? { excluded: row.querySelector('[data-shell-excluded]')?.textContent ?? null, exit: row.querySelector('[data-shell-mark="exit"]') != null } : null;
    })()`);
    steps.push({
        step: `pi ${name}: the \`!!\` command row says it was kept out of the model's context`,
        ok: bangBang != null && /context/.test(bangBang.excluded ?? "") && !bangBang.exit,
        detail: JSON.stringify(bangBang),
    });
    await h.shot(`cdp-shots/transcript-census-projection-pi-${name}.png`);
    return steps;
}

export const transcriptCensusProjection = {
    name: "transcript-census-projection",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        const entries = await projectInPage(h, RAW);
        steps.push({
            step: "projectInPage projects the census records",
            ok: Array.isArray(entries) && entries.length > 0,
            detail: JSON.stringify(entries)?.slice(0, 300),
        });
        if (!Array.isArray(entries)) return steps;
        for (const [name, host] of Object.entries(HOSTS)) {
            steps.push(...(await hostSteps(h, name, host, entries)));
        }
        const piEntries = await projectPiInPage(h, piRecords());
        steps.push({
            step: "projectPiInPage projects the pi records",
            ok: Array.isArray(piEntries) && piEntries.length > 0,
            detail: JSON.stringify(piEntries)?.slice(0, 300),
        });
        if (!Array.isArray(piEntries)) return steps;
        for (const [name, host] of Object.entries(HOSTS)) {
            steps.push(...(await piHostSteps(h, name, host, piEntries)));
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
