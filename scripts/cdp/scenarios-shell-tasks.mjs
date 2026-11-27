// Shell and monitor task scenarios: an agent's background shell and monitor tasks in the Agent tree.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { APP_MOD, RAIL_VISIBLE_KEY, TREE_RAIL_FIXTURE, restoreLocalStorage, teardownFixtureRun } from "./scenarios-shared.mjs";
import { closeTabs, makeTab, pinDefaultView, restoreDefaultView } from "./agent-page-fixtures.mjs";

// --- shell-tasks: an idle agent with a background shell task still running reads standing by -----------
// docs/superpowers/plans/2026-10-12-shell-task-standing-by.md. A plain fixture agent, idle past the 5-minute grace
// window, whose transcript starts five Bash background tasks in the record shapes claude writes: four running (output
// with lines, an empty output, an output path that does not exist, output redirected to a /tmp log) and one failed,
// which is not listed: a task that ended is gone however it ended. Finishing the four running tasks ends its standing
// by. A second agent, idle a minute, holds one failed task and nothing running: its tree row has no chip. A third
// agent starts working with no tasks: steps 7-9 start a task and turn it idle right behind it, as a Stop does.
const SHELL_AGENT = { id: "fx-shell-tasks", name: "shell-tasks agent" };
const SHELL_FAILED_AGENT = { id: "fx-shell-failed", name: "shell-failed agent" };
const SHELL_STOP_AGENT = { id: "fx-shell-stop", name: "shell-stop agent" };
const SHELL_STOP_TASKS = [
    { id: "bshserve", description: "serve the preview", output: ["preview on :4173"] },
    { id: "bshwatch", description: "watch the preview build", output: [] },
];
const SHELL_TASKS = [
    { id: "bshlines", description: "tail the dev server log", output: ["vite v6 dev server", "ready on :5173", "GET / 200"] },
    { id: "bshempty", description: "watch the test suite", output: [] },
    { id: "bshgone", description: "poll the build queue", output: null },
    // its command sends stdout to a Git Bash /tmp file, so claude's own output file stays empty
    { id: "bshredir", description: "run the dev app into a log", output: ["dev app booting", "wavesrv ready"], redirect: true },
    {
        id: "bshfail",
        description: "run the migration check",
        output: ["checking 12 migrations", "migration 0042 is out of order", "[exited with code 1]"],
        failed: true,
    },
];
const SHELL_ONLY_FAILED = {
    id: "bshlint",
    description: "lint the changed files",
    output: ["2 problems", "[exited with code 1]"],
    failed: true,
};
const SHELL_RUNNING = SHELL_TASKS.filter((t) => !t.failed);
const SHELL_APPENDED_LINE = "GET /health 200";
const SHELL_LIB = `
    const until = async (fn, n = 80) => {
        for (let i = 0; i < n && !fn(); i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        return !!fn();
    };
    const text = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    // the band label is uppercased by CSS, which innerText reports
    const band = (el) => text(el).toLowerCase();
    const tree = () => document.querySelector("[data-agent-tree]");
    const treeRow = (name) => {
        const leaf = [...(tree()?.querySelectorAll("div") ?? [])].find(
            (d) => d.textContent.trim() === name && d.children.length === 0
        );
        return leaf ? leaf.closest(".cursor-pointer") : null;
    };
    const tasksChip = (name) => treeRow(name)?.querySelector('button[aria-label$="shell tasks"]') ?? null;
    const taskRow = (id) => tree()?.querySelector('[data-shell-task="' + id + '"]') ?? null;
    const taskRowIds = () => [...(tree()?.querySelectorAll("[data-shell-task]") ?? [])].map((r) => r.getAttribute("data-shell-task"));
    const peek = () => document.querySelector("[data-shell-task-peek]");
    // the first dot in a tree row or the header is the agent's own
    const dot = (el) => {
        const d = el?.querySelector("span.rounded-full");
        return d ? { bg: d.style.backgroundColor, pulse: d.classList.contains("pulse-dot") } : null;
    };
    // the Agent surface header holds one dot, the focused agent's
    const header = () => document.querySelector("[data-agent-header]");
    const headerDot = () => ({
        name: text(header()).includes(${JSON.stringify(SHELL_AGENT.name)}),
        dot: dot(header()),
        pill: text(header()?.querySelector("[data-agent-state-pill]")),
    });
    // the finish events the shell records for an agent (useRailTracking), which the project Overview lists
    ${APP_MOD}
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { agentEventsAtom } = await mod("app/view/agents/cockpiteventsrail.tsx");
    const finishedRows = (name) => globalStore.get(agentEventsAtom).filter((e) => e.who === name && e.kind === "finished");
`;

// the file a redirect task's command writes to: /tmp in Git Bash is the user's temp dir, which wavesrv resolves
function shellRedirectFile(task, outDir) {
    const name = `${basename(outDir)}-${task.id}.log`;
    return { shellPath: `/tmp/${name}`, path: join(tmpdir(), name) };
}

function shellTaskStart(task, outDir, timestamp) {
    const toolUseId = `toolu_${task.id}`;
    const command = task.redirect ? `./${task.id}.sh > ${shellRedirectFile(task, outDir).shellPath} 2>&1` : `./${task.id}.sh`;
    const use = {
        type: "assistant",
        timestamp,
        message: {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Bash",
                    input: { command, description: task.description, run_in_background: true },
                },
            ],
        },
    };
    const start = {
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Command running in background with ID: ${task.id}. Output is being written to: ${join(outDir, `${task.id}.output`)}. You will be notified when it completes. To check interim output, use Read on that file path.`,
                    is_error: false,
                },
            ],
        },
        toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: task.id },
    };
    return [use, start];
}

// the queue-operation enqueue claude writes when a background task ends
function shellTaskFinish(task, outDir, status, summary) {
    return {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: new Date().toISOString(),
        content: [
            "<task-notification>",
            `<task-id>${task.id}</task-id>`,
            `<tool-use-id>toolu_${task.id}</tool-use-id>`,
            `<output-file>${join(outDir, `${task.id}.output`)}</output-file>`,
            `<status>${status}</status>`,
            `<summary>${summary}</summary>`,
            "</task-notification>",
        ].join("\n"),
    };
}

function writeShellTranscript(cwd, name, tasks) {
    const started = new Date(Date.now() - 8 * 60_000).toISOString();
    const records = [{ type: "user", cwd, timestamp: started, message: { role: "user", content: `verify ${name}` } }];
    for (const t of tasks) {
        records.push(...shellTaskStart(t, cwd, started));
        const outFile = t.redirect ? shellRedirectFile(t, cwd).path : join(cwd, `${t.id}.output`);
        if (t.output != null) writeFileSync(outFile, t.output.map((l) => l + "\n").join(""));
        if (t.redirect) writeFileSync(join(cwd, `${t.id}.output`), "");
        if (t.failed) {
            records.push(shellTaskFinish(t, cwd, "failed", `Background command "${t.description}" failed with exit code 1`));
        }
    }
    const transcript = join(cwd, `${name}.jsonl`);
    writeFileSync(transcript, records.map((r) => JSON.stringify(r) + "\n").join(""));
    return transcript;
}

export const shellTasksScenario = {
    name: "shell-tasks",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-shell-tasks-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        try {
            ctx.transcript = writeShellTranscript(cwd, "shell-tasks", SHELL_TASKS);
            const failedTranscript = writeShellTranscript(cwd, "shell-failed", [SHELL_ONLY_FAILED]);
            ctx.stopTranscript = writeShellTranscript(cwd, "shell-stop", []);
            // the Agent surface mounts the focused agent's terminal, whose controller resync fails on a made-up block
            // and reads failed to start; a real block with no controller resyncs without starting anything
            const blockIds = {};
            for (const a of [SHELL_AGENT, SHELL_FAILED_AGENT, SHELL_STOP_AGENT]) {
                blockIds[a.id] = (await makeTab(h, ctx, { label: `verify-${a.id}`, blockMeta: { view: "term", controller: null } })).blockId;
            }
            const now = Date.now();
            const agent = (a, transcriptPath, idleSince, task) => ({
                id: a.id,
                name: a.name,
                project: "verify-shell-tasks",
                task,
                activity: task,
                state: "idle",
                idleSince,
                agent: "claude",
                model: "opus",
                blockId: blockIds[a.id],
                transcriptPath,
            });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        // past IDLE_GRACE_MS: only standing by keeps this card on the grid
                        agent(SHELL_AGENT, ctx.transcript, now - 8 * 60_000, "start the dev server and stand by"),
                        agent(SHELL_FAILED_AGENT, failedTranscript, now - 60_000, "lint the changed files"),
                        { ...agent(SHELL_STOP_AGENT, ctx.stopTranscript, undefined, "build the preview"), state: "working" },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the agent rail is off by default and persisted, and the fixture roster is read once at boot
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            // the rail under test shows in the Terminal view; the Rendered view has the workspace pane in its place; pinned after the reload, which would drop the pin's saved value
            await pinDefaultView(h, "terminal");
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await h.goto("agent");
            ctx.loaded = await h.ev(`(async () => {
                ${SHELL_LIB}
                const name = ${JSON.stringify(SHELL_AGENT.name)};
                const ok = await until(() => tasksChip(name) != null && dot(treeRow(name))?.bg === "var(--color-accent)");
                return { ok, row: text(treeRow(name)).slice(0, 300) };
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const mainName = JSON.stringify(SHELL_AGENT.name);
        rec(
            "0. the fixture agent idle past the grace window is standing by in the Agent tree, with its shell tasks chip",
            ctx.arrangeError == null && ctx.loaded?.ok === true,
            ctx.arrangeError ?? JSON.stringify(ctx.loaded)
        );
        if (ctx.arrangeError != null) return steps;

        const centerOf = (expr) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                const el = ${expr};
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);

        // 2. TreeCollapsed: the tree row folded, no task rows
        await h.goto("agent");
        const folded = await h.ev(`(async () => {
            ${SHELL_LIB}
            if (!(await until(() => tasksChip(${mainName}) != null))) return { ok: false, why: "no shell tasks chip in the tree" };
            treeRow(${mainName}).click();
            if (tasksChip(${mainName}).getAttribute("aria-expanded") === "true") tasksChip(${mainName}).click();
            await until(() => taskRowIds().length === 0, 20);
            await new Promise((r) => setTimeout(r, 400));
            const chip = tasksChip(${mainName});
            await until(() => headerDot().name, 20);
            return {
                ok: true,
                failedOnly: { row: treeRow(${JSON.stringify(SHELL_FAILED_AGENT.name)}) != null, chip: tasksChip(${JSON.stringify(SHELL_FAILED_AGENT.name)}) != null },
                chip: text(chip),
                expanded: chip.getAttribute("aria-expanded"),
                rows: taskRowIds(),
                dot: dot(treeRow(${mainName})),
                header: headerDot(),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-collapsed.png");
        rec(
            "2. TreeCollapsed: the row's chip reads 4 shell tasks, folded, with no task rows and a still accent dot",
            folded.ok === true &&
                folded.chip.includes("4 shell tasks") &&
                folded.expanded === "false" &&
                folded.rows.length === 0 &&
                folded.dot?.bg === "var(--color-accent)" &&
                folded.dot?.pulse === false,
            JSON.stringify(folded)
        );
        rec(
            "2a. an idle agent with only a failed task has no shell tasks chip in the tree",
            folded.failedOnly?.row === true && folded.failedOnly.chip === false,
            JSON.stringify(folded.failedOnly ?? folded)
        );
        rec(
            "2b. the Agent surface header of the standing-by agent: an accent, still dot and a standing by pill",
            folded.header?.name === true &&
                folded.header.dot?.bg === "var(--color-accent)" &&
                folded.header.dot?.pulse === false &&
                folded.header.pill === "standing by",
            JSON.stringify(folded.header)
        );

        // 3. TreeExpanded: the four running tasks' rows, none for the failed one
        const expanded = await h.ev(`(async () => {
            ${SHELL_LIB}
            tasksChip(${mainName})?.click();
            await until(() => taskRowIds().length === ${SHELL_RUNNING.length}, 20);
            await new Promise((r) => setTimeout(r, 400));
            return {
                expanded: tasksChip(${mainName})?.getAttribute("aria-expanded"),
                rows: taskRowIds().map((id) => ({ id, lines: (taskRow(id)?.innerText ?? "").split("\\n").map((s) => s.trim()).filter(Boolean) })),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-expanded.png");
        const sub = (id) => expanded.rows.find((r) => r.id === id)?.lines[1] ?? "";
        rec(
            "3. TreeExpanded: four running task rows, and no row for the failed task",
            expanded.expanded === "true" &&
                expanded.rows.length === SHELL_RUNNING.length &&
                SHELL_RUNNING.every((t) => /^running · /.test(sub(t.id))) &&
                !expanded.rows.some((r) => r.id === "bshfail"),
            JSON.stringify(expanded)
        );

        // 3b. Kill: a row's X shows on hover; right-click offers its output and Kill task. The fixture block has
        // no live job, so the kill reaches wavesrv and comes back refused: a toast, and the row stays
        const killAt = await centerOf(`taskRow("bshlines")`);
        if (killAt) await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: killAt.x, y: killAt.y });
        const kill = await h.ev(`(async () => {
            ${SHELL_LIB}
            const x = () => taskRow("bshlines")?.querySelector("[data-shell-task-kill]");
            await until(() => x() != null && getComputedStyle(x()).opacity === "1", 20);
            const hovered = x() ? getComputedStyle(x()).opacity : null;
            const other = taskRow(${JSON.stringify(SHELL_RUNNING.find((t) => t.id !== "bshlines").id)})?.querySelector("[data-shell-task-kill]");
            const unhovered = other ? getComputedStyle(other).opacity : null;
            return { label: x()?.getAttribute("aria-label"), hovered, unhovered };
        })()`);
        await h.shot("cdp-shots/shell-tasks-kill-hover.png");
        const menu = await h.ev(`(async () => {
            ${SHELL_LIB}
            const r = taskRow("bshlines").getBoundingClientRect();
            taskRow("bshlines").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
            const item = (label) => [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
            await until(() => item("Kill task") != null, 20);
            return ["Show output", "Kill task"].filter((l) => item(l) != null);
        })()`);
        await h.shot("cdp-shots/shell-tasks-kill-menu.png");
        const killed = await h.ev(`(async () => {
            ${SHELL_LIB}
            const item = (label) => [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
            item("Kill task")?.click();
            const toast = () => [...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes("Kill shell task"));
            await until(() => toast() != null, 40);
            const msg = text(toast());
            toast()?.click();
            return { toast: msg, rowStays: taskRow("bshlines") != null, menuClosed: item("Kill task") == null };
        })()`);
        rec(
            "3b. Kill: the X shows on the hovered row only; right-click offers Show output and Kill task; a refused kill toasts and keeps the row",
            kill.label === "Kill tail the dev server log" &&
                kill.hovered === "1" &&
                kill.unhovered === "0" &&
                menu.join(",") === "Show output,Kill task" &&
                killed.toast?.includes("Not killed") &&
                killed.rowStays === true &&
                killed.menuClosed === true,
            JSON.stringify({ kill, menu, killed })
        );

        // 4. Interactive: the output opens in a peek beside the tree, re-reads live, and every way it closes
        const clickRow = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                taskRow(${JSON.stringify(id)})?.click();
                await new Promise((r) => setTimeout(r, 400));
            })()`);
        const peekState = (id, want) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                const want = ${JSON.stringify(want ?? null)};
                await until(() => peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)} && (want == null || text(peek()).includes(want)), 40);
                await new Promise((r) => setTimeout(r, 300));
                const p = peek();
                if (!p) return null;
                const lines = p.innerText.split("\\n").map((s) => s.trim()).filter(Boolean);
                return {
                    id: p.getAttribute("data-shell-task-peek"),
                    text: text(p),
                    state: text(p.querySelector("[data-shell-task-state]")),
                    footer: lines.at(-1) ?? "",
                    besideTree: p.getBoundingClientRect().left >= (tree()?.getBoundingClientRect().right ?? Infinity),
                    headerShown: header()?.checkVisibility() === true,
                    rowOpen: taskRow(${JSON.stringify(id)})?.classList.contains("bg-accentbg") ?? false,
                };
            })()`);
        const peekGone = () =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                return await until(() => peek() == null, 20);
            })()`);
        // Escape where the user's focus is, so the keybinding dispatcher's window listener sees it as a keypress
        const escape = () =>
            h.ev(`(document.activeElement || document.body).dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
            )`);
        const closeButton = () => h.ev(`document.querySelector('[data-shell-task-peek] button[aria-label="Close output"]')?.click()`);

        await clickRow("bshlines");
        const lines = await peekState("bshlines", "ready on :5173");
        await h.shot("cdp-shots/shell-tasks-peek-lines.png");
        rec(
            "4a. Interactive: the running task's output opens in a peek beside the tree, the terminal still showing, state running, footer last 64 KB · live, its row highlighted",
            lines?.id === "bshlines" &&
                SHELL_TASKS[0].output.every((l) => lines.text.includes(l)) &&
                lines.state === "running" &&
                lines.footer.endsWith("last 64 KB · live") &&
                lines.besideTree === true &&
                lines.headerShown === true &&
                lines.rowOpen === true,
            JSON.stringify(lines)
        );

        appendFileSync(join(ctx.cwd, "bshlines.output"), SHELL_APPENDED_LINE + "\n");
        const live = await peekState("bshlines", SHELL_APPENDED_LINE);
        rec(
            "4b. a line appended to a running task's output appears in the open peek",
            live?.text.includes(SHELL_APPENDED_LINE) === true,
            JSON.stringify(live?.text)
        );

        await clickRow("bshlines");
        const toggled = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        await closeButton();
        const closed = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        await escape();
        const escaped = await peekGone();
        // Esc closes only the peek: agent:back would have left the Agent surface for Cockpit
        const stayed = await h.ev(`(async () => { ${SHELL_LIB} return tree()?.checkVisibility() === true; })()`);
        await clickRow("bshlines");
        await peekState("bshlines");
        // the peek dismisses on pointerdown, so a real press: on the agent's own row, outside the peek and its task row
        const outside = await centerOf(`treeRow(${JSON.stringify(SHELL_AGENT.name)})`);
        if (outside) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: outside.x, y: outside.y });
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: outside.x, y: outside.y, button: "left", clickCount: 1 });
            }
        }
        const pressedOut = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        const folding = await h.ev(`(async () => {
            ${SHELL_LIB}
            tasksChip(${mainName})?.click();
            const gone = await until(() => peek() == null, 20);
            tasksChip(${mainName})?.click();
            await until(() => taskRowIds().length === ${SHELL_RUNNING.length}, 20);
            await new Promise((r) => setTimeout(r, 400));
            return gone;
        })()`);
        // the Agent surface stays mounted off-screen, so a peek left open would float over the next surface
        await clickRow("bshlines");
        await peekState("bshlines");
        await h.goto("cockpit");
        const leftSurface = await peekGone();
        await h.goto("agent");
        const notBack = await h.ev(`(async () => {
            ${SHELL_LIB}
            await new Promise((r) => setTimeout(r, 600));
            return peek() == null;
        })()`);
        rec(
            "4c. the peek closes on re-clicking its row, the close button, Esc (staying on Agent), a press outside, folding the chip, and leaving the surface",
            toggled && closed && escaped && stayed && pressedOut && folding && leftSurface && notBack,
            JSON.stringify({ toggled, closed, escaped, stayed, pressedOut, folding, leftSurface, notBack })
        );

        await clickRow("bshempty");
        const empty = await peekState("bshempty", "No output yet.");
        await h.shot("cdp-shots/shell-tasks-peek-empty.png");
        rec(
            "4d. the empty task's peek reads No output yet. (running, live)",
            empty?.text.includes("No output yet.") === true &&
                empty.state === "running" &&
                empty.footer.endsWith("last 64 KB · live"),
            JSON.stringify(empty)
        );

        // 5. a missing output file reads as no output, not an error
        await clickRow("bshgone");
        const gone = await peekState("bshgone", "No output yet.");
        await h.shot("cdp-shots/shell-tasks-peek-missing.png");
        rec(
            "5. the task whose output file does not exist reads No output yet., with no error text",
            gone?.text.includes("No output yet.") === true && !/error|enoent|no such file|cannot|failed/i.test(gone.text),
            JSON.stringify(gone)
        );

        // 5a. a command that redirects its stdout leaves claude's output file empty; the peek reads the redirect target
        const redirTask = SHELL_TASKS.find((t) => t.redirect);
        await clickRow(redirTask.id);
        const redir = await peekState(redirTask.id, redirTask.output.at(-1));
        await h.shot("cdp-shots/shell-tasks-peek-redirect.png");
        rec(
            "5a. the task whose command redirects to a /tmp log shows that log's lines, not No output yet. (running)",
            redir != null &&
                redirTask.output.every((l) => redir.text.includes(l)) &&
                !redir.text.includes("No output yet.") &&
                redir.state === "running",
            JSON.stringify(redir)
        );
        await closeButton();
        await peekGone();

        const resume = await h.ev(`(async () => {
            ${SHELL_LIB}
            const rail = () => document.querySelector('aside[aria-label="Agent details"]');
            await until(() => text(rail()).includes(${mainName}), 20);
            return { rail: rail() != null, resume: [...(rail()?.querySelectorAll("button") ?? [])].some((b) => text(b) === "Resume") };
        })()`);
        rec(
            "5b. the agent details rail offers no Resume nudge while the agent stands by",
            resume.rail === true && resume.resume === false,
            JSON.stringify(resume)
        );

        // 6. Finish: the running tasks end, which ends standing by and records one finish
        appendFileSync(
            ctx.transcript,
            SHELL_RUNNING.map((t) => JSON.stringify(shellTaskFinish(t, ctx.cwd, "completed", "completed (exit code 0)")) + "\n").join("")
        );
        const finished = await h.ev(`(async () => {
            ${SHELL_LIB}
            // the 5s poll is what reads the finish records of an idle agent
            const ended = await until(() => tasksChip(${mainName}) == null, 120);
            await until(() => finishedRows(${mainName}).length > 0, 20);
            await new Promise((r) => setTimeout(r, 800));
            return { ended, finished: finishedRows(${mainName}).length };
        })()`);
        rec(
            "6. Finish: the shell tasks chip leaves the tree and exactly one finished event is recorded",
            finished.ended === true && finished.finished === 1,
            JSON.stringify(finished)
        );

        await h.goto("agent");
        const after = await h.ev(`(async () => {
            ${SHELL_LIB}
            await until(() => treeRow(${mainName}) != null, 20);
            if (!headerDot().name) treeRow(${mainName})?.click();
            await until(() => tasksChip(${mainName}) == null, 20);
            await until(() => headerDot().name, 20);
            await new Promise((r) => setTimeout(r, 600));
            return {
                chip: tasksChip(${mainName}) == null ? null : text(tasksChip(${mainName})),
                rows: taskRowIds().filter((id) => ${JSON.stringify(SHELL_TASKS.map((t) => t.id))}.includes(id)),
                dot: dot(treeRow(${mainName})),
                header: headerDot(),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-finished.png");
        rec(
            "6b. the tree has no shell tasks chip and no task rows, and the dot is no longer accent",
            after.chip === null &&
                after.rows.length === 0 &&
                after.dot != null &&
                after.dot.bg !== "var(--color-accent)" &&
                after.dot.pulse === false,
            JSON.stringify(after)
        );
        rec(
            "6c. after the finish the Agent surface header dot is no longer accent and its pill reads idle",
            after.header?.name === true &&
                after.header.dot != null &&
                after.header.dot.bg !== "var(--color-accent)" &&
                after.header.pill === "idle",
            JSON.stringify(after.header)
        );

        // 7. A Stop right behind a background start: the agent turns idle before the shell-task read lands, and
        // the hold keeps a finish from being recorded in between
        const stop = JSON.stringify(SHELL_STOP_AGENT.id);
        const stopName = JSON.stringify(SHELL_STOP_AGENT.name);
        const startTask = (t) => {
            writeFileSync(join(ctx.cwd, `${t.id}.output`), t.output.map((l) => l + "\n").join(""));
            const recs = shellTaskStart(t, ctx.cwd, new Date().toISOString());
            appendFileSync(ctx.stopTranscript, recs.map((r) => JSON.stringify(r) + "\n").join(""));
        };
        const SETTLE = `'[class*="animate-[settle"]'`;
        startTask(SHELL_STOP_TASKS[0]);
        const stopped = await h.ev(`(async () => {
            ${SHELL_LIB}
            const fx = window.__cockpitRosterFixture;
            if (fx == null) return { ok: false, why: "no __cockpitRosterFixture seam" };
            if (!(await until(() => treeRow(${stopName}) != null, 40))) return { ok: false, why: "no tree row for the working agent" };
            fx.patch(${stop}, { state: "idle", idleSince: Date.now() });
            const standing = await until(() => dot(treeRow(${stopName}))?.bg === "var(--color-accent)", 40);
            await new Promise((r) => setTimeout(r, 1500));
            return { ok: true, standing, finished: finishedRows(${stopName}).length };
        })()`);
        rec(
            "7. a Stop right behind a background start goes straight to standing by and records no finished event",
            stopped.ok === true && stopped.standing === true && stopped.finished === 0,
            JSON.stringify(stopped)
        );

        // 8. Its task ends: standing by ends and the finish is recorded once
        appendFileSync(
            ctx.stopTranscript,
            JSON.stringify(shellTaskFinish(SHELL_STOP_TASKS[0], ctx.cwd, "completed", "completed (exit code 0)")) + "\n"
        );
        const regraced = await h.ev(`(async () => {
            ${SHELL_LIB}
            // the 5s poll is what reads the finish record of an idle agent
            const back = await until(() => finishedRows(${stopName}).length > 0, 120);
            await new Promise((r) => setTimeout(r, 800));
            return { back, finished: finishedRows(${stopName}).length };
        })()`);
        rec(
            "8. the task ending records exactly one finished event",
            regraced.back === true && regraced.finished === 1,
            JSON.stringify(regraced)
        );

        // 9. The same Stop race on the Agent surface: neither the tree row nor the header pill settles before the read
        await h.goto("agent");
        const working = await h.ev(`(async () => {
            ${SHELL_LIB}
            window.__cockpitRosterFixture?.patch(${stop}, { state: "working", idleSince: undefined });
            if (!(await until(() => treeRow(${stopName}) != null, 40))) return { ok: false, why: "no tree row" };
            treeRow(${stopName}).click();
            return { ok: await until(() => text(header()).includes(${stopName}), 20) };
        })()`);
        startTask(SHELL_STOP_TASKS[1]);
        const treeStop = working.ok
            ? await h.ev(`(async () => {
                  ${SHELL_LIB}
                  let row = false;
                  let pill = false;
                  const look = () => {
                      if (treeRow(${stopName})?.matches(${SETTLE})) row = true;
                      if (header()?.querySelector("[data-agent-state-pill]")?.matches(${SETTLE})) pill = true;
                  };
                  const mo = new MutationObserver(look);
                  mo.observe(document.body, { subtree: true, childList: true, attributes: true });
                  window.__cockpitRosterFixture.patch(${stop}, { state: "idle", idleSince: Date.now() });
                  const standing = await until(() => dot(treeRow(${stopName}))?.bg === "var(--color-accent)", 40);
                  await new Promise((r) => setTimeout(r, 1500));
                  mo.disconnect();
                  look();
                  return {
                      ok: true,
                      standing,
                      rowSettled: row,
                      pillSettled: pill,
                      pill: text(header()?.querySelector("[data-agent-state-pill]")),
                  };
              })()`)
            : working;
        await h.shot("cdp-shots/shell-tasks-stop-tree.png");
        rec(
            "9. on the Agent surface the same Stop settles neither the tree row nor the header pill, which reads standing by",
            treeStop.ok === true &&
                treeStop.standing === true &&
                treeStop.rowSettled === false &&
                treeStop.pillSettled === false &&
                treeStop.pill === "standing by",
            JSON.stringify(treeStop)
        );
        return steps;
    },
    async teardown(h, ctx) {
        // teardownFixtureRun removes the fixture roster, reloads onto the live roster and deletes the temp dir with
        // the transcripts and output files; a redirect task's log sits outside it
        for (const t of SHELL_TASKS.filter((t) => t.redirect)) rmSync(shellRedirectFile(t, ctx.cwd).path, { force: true });
        await closeTabs(h, ctx);
        await teardownFixtureRun(h, ctx, "shell-tasks", {
            what: "restore the rail's visibility and the default view",
            fn: async () => {
                await h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail));
                await restoreDefaultView(h);
            },
        });
    },
};

// --- monitor-tasks: Claude Code Monitor tasks beside shell tasks in the Agent tree, the peek and the card ----------
// docs/superpowers/plans/2026-10-27-monitor-tasks.md, boards Main / PeekOutput / PeekEmpty. Two fixture agents idle
// past the grace window: one with a shell task, two live monitors and three that ended (expired, stream ended,
// TaskStop), which must not list; one with a persistent monitor. Only standing by keeps their cards on the grid.
const MONITOR_AGENT = { id: "fx-monitor-tasks", name: "monitor-tasks agent" };
const MONITOR_PERSIST_AGENT = { id: "fx-monitor-persistent", name: "monitor-persistent agent" };
const MIN = 60_000;
const MONITOR_SHELL = { id: "bmtshell", description: "serve the preview", output: ["preview on :4173"] };
const MONITOR_STRAY_LINE = "grep: warning: stray \\ before -";
const MONITORS = [
    {
        id: "bmtevents",
        description: "final-verify PASS/FAIL lines",
        command: 'tail -f final-verify.log | grep --line-buffered -E "PASS|FAIL\\-"',
        startedAgo: 12 * MIN,
        timeoutMs: 30 * MIN,
        events: [
            { ago: 10 * MIN, lines: ["PASS surface-smoke"] },
            { ago: 7 * MIN, lines: ["FAIL shell-tasks", "3b. Kill: the X shows on the hovered row only"] },
            { ago: 4 * MIN, lines: ["PASS shell-tasks"] },
            { ago: 1.5 * MIN, lines: ["PASS monitor-tasks"] },
        ],
        output: "stray",
    },
    {
        id: "bmtquiet",
        description: "errors in waveapp.log",
        command: 'tail -f waveapp.log | grep --line-buffered "error"',
        startedAgo: 2 * MIN,
        timeoutMs: 30 * MIN,
        events: [],
        output: "empty",
    },
    {
        id: "bmtexpired",
        description: "tail the old build log",
        command: "tail -f build.log",
        startedAgo: 40 * MIN,
        timeoutMs: 30 * MIN,
        events: [],
    },
    {
        id: "bmtended",
        description: "watch the deploy stream",
        command: "./deploy-stream.sh",
        startedAgo: 35 * MIN,
        timeoutMs: 60 * MIN,
        events: [],
        endedAgo: 30 * MIN,
    },
    {
        id: "bmtstopped",
        description: "poll the review queue",
        command: "./review-queue.sh",
        startedAgo: 25 * MIN,
        timeoutMs: 60 * MIN,
        events: [],
        stoppedAgo: 20 * MIN,
    },
];
const MONITOR_LIVE = MONITORS.filter((m) => m.output != null);
const MONITOR_GONE = MONITORS.filter((m) => m.output == null);
const MONITOR_PERSIST = {
    id: "bmtpersist",
    description: "watch the CI queue",
    command: "./ci-queue.sh",
    startedAgo: 45 * MIN,
    timeoutMs: 30 * MIN,
    persistent: true,
    events: [
        { ago: 30 * MIN, lines: ["build 812 queued"] },
        { ago: 3 * MIN, lines: ["build 813 queued"] },
    ],
};
const MONITOR_LIB = `
    // the agent row's fold chip for its task list, whatever kinds it holds
    const chip = (name) =>
        [...(treeRow(name)?.querySelectorAll("button[aria-label]") ?? [])].find((b) =>
            /^(Show|Hide) (shell tasks|monitors|tasks)$/.test(b.getAttribute("aria-label"))
        ) ?? null;
    const sub = (id) => text(taskRow(id)?.querySelector("[data-task-sub]"));
    const left = (id) => taskRow(id)?.querySelector("[data-monitor-left]") ?? null;
    const mark = (id) => taskRow(id)?.querySelector("svg[aria-label]")?.getAttribute("aria-label") ?? null;
    const tab = (name) => peek()?.querySelector('[data-peek-tab="' + name + '"]') ?? null;
    const footer = () => text(peek()?.querySelector("[data-peek-footer]"));
    const menuItem = (label) =>
        [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
`;

// claude writes a monitor's output under its temp dir, keyed by the transcript's project dir and session
function monitorOutFile(transcript, id) {
    return join(tmpdir(), "claude", basename(dirname(transcript)), basename(transcript, ".jsonl"), "tasks", `${id}.output`);
}

function monitorNotification(m, body) {
    return [
        "<task-notification>",
        `<task-id>${m.id}</task-id>`,
        `<summary>Monitor event: "${m.description}"</summary>`,
        `<event>${body}</event>`,
        "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
        "</task-notification>",
    ].join("\n");
}

// the assistant Monitor tool_use and the user record of its start result
function monitorTaskStart(m, now) {
    const toolUseId = `toolu_${m.id}`;
    const timestamp = new Date(now - m.startedAgo).toISOString();
    const input = { description: m.description, timeout_ms: m.timeoutMs, command: m.command };
    if (m.persistent) input.persistent = true;
    const use = {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Monitor", input }] },
    };
    const start = {
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Monitor started (task ${m.id}, expires in ${m.timeoutMs / MIN}m unless the source ends first; events arrive as notifications.)`,
                },
            ],
        },
        toolUseResult: { taskId: m.id, timeoutMs: m.timeoutMs, persistent: m.persistent === true },
    };
    return [use, start];
}

// every event is written twice: the queue-operation enqueue, then the user record a turn delivers it in
function monitorEvent(m, ev, now) {
    const content = monitorNotification(m, ev.lines.join("\n"));
    return [
        { type: "queue-operation", operation: "enqueue", timestamp: new Date(now - ev.ago).toISOString(), content },
        { type: "user", timestamp: new Date(now - ev.ago + 1000).toISOString(), message: { role: "user", content } },
    ];
}

// a stream-ended notification, or the TaskStop tool_use and its success result
function monitorEnd(m, transcript, now) {
    if (m.stoppedAgo != null) {
        const timestamp = new Date(now - m.stoppedAgo).toISOString();
        const toolUseId = `toolu_stop_${m.id}`;
        const message = `Successfully stopped task: ${m.id} (${m.command})`;
        return [
            {
                type: "assistant",
                timestamp,
                message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "TaskStop", input: { task_id: m.id } }] },
            },
            {
                type: "user",
                timestamp,
                message: {
                    role: "user",
                    content: [{ tool_use_id: toolUseId, type: "tool_result", content: JSON.stringify({ message, task_id: m.id }) }],
                },
                toolUseResult: { message, task_id: m.id, command: m.command },
            },
        ];
    }
    return [
        {
            type: "queue-operation",
            operation: "enqueue",
            timestamp: new Date(now - m.endedAgo).toISOString(),
            content: [
                "<task-notification>",
                `<task-id>${m.id}</task-id>`,
                `<tool-use-id>toolu_${m.id}</tool-use-id>`,
                `<output-file>${monitorOutFile(transcript, m.id)}</output-file>`,
                "<status>completed</status>",
                `<summary>Monitor "${m.description}" stream ended</summary>`,
                "</task-notification>",
            ].join("\n"),
        },
    ];
}

function writeMonitorTranscript(cwd, name, shellTasks, monitors) {
    const now = Date.now();
    const transcript = join(cwd, `${name}.jsonl`);
    const records = [];
    for (const t of shellTasks) {
        records.push(...shellTaskStart(t, cwd, new Date(now - 14 * MIN).toISOString()));
        writeFileSync(join(cwd, `${t.id}.output`), t.output.map((l) => l + "\n").join(""));
    }
    for (const m of monitors) {
        records.push(...monitorTaskStart(m, now));
        for (const ev of m.events) records.push(...monitorEvent(m, ev, now));
        if (m.endedAgo != null || m.stoppedAgo != null) records.push(...monitorEnd(m, transcript, now));
        if (m.output != null) {
            const out = monitorOutFile(transcript, m.id);
            mkdirSync(dirname(out), { recursive: true });
            const lines = m.output === "stray" ? [MONITOR_STRAY_LINE, ...m.events.flatMap((e) => e.lines)] : [];
            writeFileSync(out, lines.map((l) => l + "\n").join(""));
        }
    }
    // a real transcript is in time order; the shell task's start lands between the monitors'
    records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const first = { type: "user", cwd, timestamp: new Date(now - 50 * MIN).toISOString(), message: { role: "user", content: `verify ${name}` } };
    writeFileSync(transcript, [first, ...records].map((r) => JSON.stringify(r) + "\n").join(""));
    return transcript;
}

export const monitorTasksScenario = {
    name: "monitor-tasks",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-monitor-tasks-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        try {
            ctx.transcript = writeMonitorTranscript(cwd, "monitor-tasks", [MONITOR_SHELL], MONITORS);
            const persistTranscript = writeMonitorTranscript(cwd, "monitor-persistent", [], [MONITOR_PERSIST]);
            // a real block with no controller per agent: the Agent surface mounts the focused agent's terminal, and a
            // made-up block reads failed to start
            const blockIds = {};
            for (const a of [MONITOR_AGENT, MONITOR_PERSIST_AGENT]) {
                blockIds[a.id] = (await makeTab(h, ctx, { label: `verify-${a.id}`, blockMeta: { view: "term", controller: null } })).blockId;
            }
            const now = Date.now();
            const agent = (a, transcriptPath, task) => ({
                id: a.id,
                name: a.name,
                project: "verify-monitor-tasks",
                task,
                activity: task,
                state: "idle",
                // past IDLE_GRACE_MS: only standing by keeps them from reading finished
                idleSince: now - 8 * MIN,
                agent: "claude",
                model: "opus",
                blockId: blockIds[a.id],
                transcriptPath,
            });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        agent(MONITOR_AGENT, ctx.transcript, "watch final-verify and stand by"),
                        agent(MONITOR_PERSIST_AGENT, persistTranscript, "watch the CI queue"),
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the agent rail is off by default and persisted, and the fixture roster is read once at boot
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await h.goto("agent");
            ctx.loaded = await h.ev(`(async () => {
                ${SHELL_LIB}
                const names = ${JSON.stringify([MONITOR_AGENT.name, MONITOR_PERSIST_AGENT.name])};
                const ok = await until(() => names.every((n) => dot(treeRow(n))?.bg === "var(--color-accent)"));
                return { ok, row: text(treeRow(names[0])).slice(0, 300) };
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const mainName = JSON.stringify(MONITOR_AGENT.name);
        const persistName = JSON.stringify(MONITOR_PERSIST_AGENT.name);
        const liveIds = [MONITOR_SHELL.id, ...MONITOR_LIVE.map((m) => m.id)];
        rec(
            "0. both fixture agents idle past the grace window are standing by in the Agent tree",
            ctx.arrangeError == null && ctx.loaded?.ok === true,
            ctx.arrangeError ?? JSON.stringify(ctx.loaded)
        );
        if (ctx.arrangeError != null) return steps;

        const centerOf = (expr) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                const el = ${expr};
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);
        const hover = async (expr) => {
            const at = await centerOf(expr);
            if (at) await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
            return at;
        };
        const unhover = () => h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 940 });

        // 1. Main: one list under the agent, shell task first, the ended monitors gone, both agents standing by
        await h.goto("agent");
        const rows = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const ids = ${JSON.stringify(liveIds)};
            const all = ${JSON.stringify([...liveIds, ...MONITOR_GONE.map((m) => m.id)])};
            await until(() => chip(${mainName}) != null && ids.every((id) => taskRow(id) != null));
            await new Promise((r) => setTimeout(r, 400));
            const c = chip(${mainName});
            return {
                chip: text(c),
                expanded: c?.getAttribute("aria-expanded") ?? null,
                rows: taskRowIds().filter((id) => all.includes(id)),
                kinds: ids.map((id) => taskRow(id)?.getAttribute("data-task-kind") ?? null),
                marks: ids.map(mark),
                // the title tooltip host parks a hovered element's title in data-arc-title
                titles: ids.map((id) => taskRow(id)?.getAttribute("title") ?? taskRow(id)?.getAttribute("data-arc-title") ?? null),
                subs: Object.fromEntries(ids.map((id) => [id, sub(id)])),
                left: ids.slice(1).map((id) => text(left(id))),
                dots: [dot(treeRow(${mainName})), dot(treeRow(${persistName}))],
            };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-1.png");
        rec(
            "1. Main: the chip reads 3 tasks, open; rows bmtshell, bmtevents, bmtquiet with Terminal / Radio marks and their commands as titles; the expired, ended and stopped monitors are absent; both agents' dots accent",
            rows.chip === "3 tasks" &&
                rows.expanded === "true" &&
                rows.rows.join(",") === liveIds.join(",") &&
                rows.kinds.join(",") === "shell,monitor,monitor" &&
                rows.marks.join(",") === "Shell task,Monitor,Monitor" &&
                rows.titles.join("\n") === [`./${MONITOR_SHELL.id}.sh`, ...MONITOR_LIVE.map((m) => m.command)].join("\n") &&
                rows.subs.bmtevents.startsWith("4 events ·") &&
                rows.subs.bmtquiet.startsWith("no events yet ·") &&
                rows.left.every((l) => /^(\d+m|<1m) left$/.test(l)) &&
                rows.dots.every((d) => d?.bg === "var(--color-accent)"),
            JSON.stringify(rows)
        );

        // 2. Persistent and folded: no time left on a persistent monitor; the chip folds and unfolds its rows
        const persist = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const id = ${JSON.stringify(MONITOR_PERSIST.id)};
            await until(() => chip(${persistName}) != null && taskRow(id) != null);
            const before = { chip: text(chip(${persistName})), sub: sub(id), left: left(id) != null };
            chip(${persistName})?.click();
            await until(() => taskRow(id) == null, 20);
            await new Promise((r) => setTimeout(r, 400));
            const folded = {
                expanded: chip(${persistName})?.getAttribute("aria-expanded") ?? null,
                label: chip(${persistName})?.getAttribute("aria-label") ?? null,
                row: taskRow(id) != null,
            };
            return { before, folded };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-2.png");
        const unfolded = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const id = ${JSON.stringify(MONITOR_PERSIST.id)};
            chip(${persistName})?.click();
            await until(() => taskRow(id) != null, 20);
            return { expanded: chip(${persistName})?.getAttribute("aria-expanded") ?? null, row: taskRow(id) != null };
        })()`);
        rec(
            "2. Persistent: the chip reads 1 monitor, the row reads persistent · 2 events with no time left; the chip folds (Show monitors, rows gone) and unfolds",
            persist.before.chip === "1 monitor" &&
                persist.before.sub.startsWith("persistent · 2 events") &&
                persist.before.left === false &&
                persist.folded.expanded === "false" &&
                persist.folded.label === "Show monitors" &&
                persist.folded.row === false &&
                unfolded.expanded === "true" &&
                unfolded.row === true,
            JSON.stringify({ persist, unfolded })
        );

        // 3. Stop: the hovered monitor's X and menu use the monitor copy. The fixture block has no live job, so the
        // stop reaches wavesrv and comes back refused: a toast, and the row stays
        await hover(`taskRow("bmtquiet")`);
        const stopX = await h.ev(`(async () => {
            ${SHELL_LIB}
            const x = () => taskRow("bmtquiet")?.querySelector("[data-shell-task-kill]");
            await until(() => x() != null && getComputedStyle(x()).opacity === "1", 20);
            return {
                label: x()?.getAttribute("aria-label") ?? null,
                title: x()?.getAttribute("title") ?? x()?.getAttribute("data-arc-title") ?? null,
                opacity: x() ? getComputedStyle(x()).opacity : null,
            };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-3.png");
        const menu = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const r = taskRow("bmtquiet").getBoundingClientRect();
            taskRow("bmtquiet").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
            await until(() => menuItem("Stop monitor") != null, 20);
            return ["Show output", "Hide output", "Stop monitor", "Kill task"].filter((l) => menuItem(l) != null);
        })()`);
        const stopped = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            menuItem("Stop monitor")?.click();
            const toast = () => [...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes("Stop monitor"));
            await until(() => toast() != null, 40);
            const msg = text(toast());
            toast()?.click();
            await new Promise((r) => setTimeout(r, 400));
            return { toast: msg, rowStays: taskRow("bmtquiet") != null, menuClosed: menuItem("Stop monitor") == null };
        })()`);
        await unhover();
        rec(
            "3. Stop: the hovered monitor's X reads Stop errors in waveapp.log; right-click offers Show output and Stop monitor; a refused stop toasts Stop monitor / Not stopped and keeps the row",
            stopX.label === "Stop errors in waveapp.log" &&
                stopX.opacity === "1" &&
                menu.join(",") === "Show output,Stop monitor" &&
                stopped.toast?.includes("Not stopped") &&
                stopped.rowStays === true &&
                stopped.menuClosed === true,
            JSON.stringify({ stopX, menu, stopped })
        );

        const clickRow = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                taskRow(${JSON.stringify(id)})?.click();
                await new Promise((r) => setTimeout(r, 400));
            })()`);
        // a monitor row always toggles its peek: a second click closes it
        const closePeek = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                if (peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)}) taskRow(${JSON.stringify(id)})?.click();
                return await until(() => peek() == null, 20);
            })()`);
        const peekState = (id, want) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                const want = ${JSON.stringify(want ?? null)};
                await until(() => peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)} && (want == null || text(peek()).includes(want)), 40);
                await new Promise((r) => setTimeout(r, 300));
                const p = peek();
                if (!p) return null;
                const tablist = p.querySelector('[role="tablist"]');
                const tabState = (name) => (tab(name) ? { text: text(tab(name)), role: tab(name).getAttribute("role"), selected: tab(name).getAttribute("aria-selected") } : null);
                const expires = p.querySelector("[data-monitor-expires]");
                return {
                    id: p.getAttribute("data-shell-task-peek"),
                    text: text(p),
                    mark: p.querySelector("[data-peek-mark]")?.getAttribute("data-peek-mark") ?? null,
                    state: text(p.querySelector("[data-shell-task-state]")),
                    command: p.querySelector("[data-monitor-command]") ? text(p.querySelector("[data-monitor-command]")) : null,
                    tablist: tablist ? tablist.getAttribute("aria-label") : null,
                    events: tabState("events"),
                    output: tabState("output"),
                    eventTimes: [...p.querySelectorAll("[data-monitor-event]")].map((e) => text(e.querySelector("[data-monitor-event-time]"))),
                    footer: footer(),
                    expires: expires ? { text: text(expires), title: expires.getAttribute("title") } : null,
                };
            })()`);
        const selectTab = (name) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                tab(${JSON.stringify(name)})?.click();
                await until(() => tab(${JSON.stringify(name)})?.getAttribute("aria-selected") === "true", 20);
            })()`);

        // 4. Events peek: the monitor's header, command line, tabs, one row per event and the expiry footer
        const evMon = MONITORS[0];
        await clickRow(evMon.id);
        const events = await peekState(evMon.id, evMon.events.at(-1).lines[0]);
        await h.shot("cdp-shots/monitor-tasks-4.png");
        rec(
            "4. Events peek: Radio mark, watching, a $ command line, the Monitor view tablist on Events 4, four timed events, a footer of 4 events · and expires in …m",
            events?.mark === "monitor" &&
                events.state === "watching" &&
                events.command?.startsWith("$ ") &&
                events.tablist === "Monitor view" &&
                events.events?.role === "tab" &&
                events.events.selected === "true" &&
                events.events.text === `Events ${evMon.events.length}` &&
                events.eventTimes.length === evMon.events.length &&
                events.eventTimes.every((t) => /^\d\d:\d\d:\d\d$/.test(t)) &&
                evMon.events.every((e) => e.lines.every((l) => events.text.includes(l))) &&
                events.footer.startsWith(`${evMon.events.length} events ·`) &&
                /^expires in \d+m$/.test(events.expires?.text ?? "") &&
                /^expires \d\d:\d\d:\d\d$/.test(events.expires?.title ?? ""),
            JSON.stringify(events)
        );

        // 5. Output peek: the output file's tail, its stray grep warning included
        await selectTab("output");
        const output = await peekState(evMon.id, "grep: warning: stray");
        await h.shot("cdp-shots/monitor-tasks-5.png");
        rec(
            "5. Output peek: the Output tab selected, the body holds the grep warning and the event lines, the footer names bmtevents.output and last 64 KB",
            output?.output?.selected === "true" &&
                output.events?.selected === "false" &&
                output.text.includes("grep: warning: stray") &&
                evMon.events.every((e) => e.lines.every((l) => output.text.includes(l))) &&
                output.footer.includes(`${evMon.id}.output`) &&
                output.footer.includes("last 64 KB"),
            JSON.stringify(output)
        );
        await closePeek(evMon.id);

        // 6. Empty peek: a monitor with no events yet, and its empty output file
        const quiet = MONITORS[1];
        await clickRow(quiet.id);
        const empty = await peekState(quiet.id, "No events yet.");
        await h.shot("cdp-shots/monitor-tasks-6.png");
        await selectTab("output");
        const emptyOut = await peekState(quiet.id, "No output yet.");
        rec(
            "6. Empty peek: Events 0 reads No events yet. with a footer of watching since; its Output tab reads No output yet.",
            empty?.events?.text === "Events 0" &&
                empty.events.selected === "true" &&
                empty.text.includes("No events yet.") &&
                empty.eventTimes.length === 0 &&
                empty.footer.startsWith("watching since") &&
                emptyOut?.output?.selected === "true" &&
                emptyOut.text.includes("No output yet."),
            JSON.stringify({ empty, emptyOut: emptyOut && { output: emptyOut.output, text: emptyOut.text } })
        );
        await closePeek(quiet.id);

        // 7. Shell peek: a shell task keeps its plain output peek, with the Terminal mark
        await clickRow(MONITOR_SHELL.id);
        const shell = await peekState(MONITOR_SHELL.id, MONITOR_SHELL.output[0]);
        await h.shot("cdp-shots/monitor-tasks-7.png");
        rec(
            "7. Shell peek: the Terminal mark, running, no tablist and no command line",
            shell?.mark === "shell" && shell.state === "running" && shell.tablist === null && shell.command === null,
            JSON.stringify(shell)
        );
        await closePeek(MONITOR_SHELL.id);

        return steps;
    },
    async teardown(h, ctx) {
        // teardownFixtureRun deletes the temp dir with the transcripts and the shell task's output; the monitors'
        // output files sit under claude's temp dir, keyed by that temp dir's name
        rmSync(join(tmpdir(), "claude", basename(ctx.cwd)), { recursive: true, force: true });
        await closeTabs(h, ctx);
        await teardownFixtureRun(h, ctx, "monitor-tasks", {
            what: "restore the rail's visibility",
            fn: () => h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail)),
        });
    },
};
