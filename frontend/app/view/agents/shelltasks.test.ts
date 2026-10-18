// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    extractShellTasks,
    isStandingBy,
    outputTail,
    redirectTarget,
    shellKillNote,
    shellTasksLabel,
    type ShellTask,
} from "./shelltasks";

// fixtures trimmed from real claude transcripts under ~/.claude/projects
const OUT_DIR =
    "C:\\Users\\kael02\\AppData\\Local\\Temp\\claude\\C--Users-kael02-IdeaProjects-waveterm\\1d7ff3b9\\tasks";

function bashUse(toolUseId: string, input: Record<string, unknown>): string {
    return JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-06T08:55:38.000Z",
        message: {
            role: "assistant",
            content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { run_in_background: true, ...input } }],
        },
    });
}

function bashStart(toolUseId: string, taskId: string, timestamp = "2026-10-06T08:55:39.046Z"): string {
    return JSON.stringify({
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Command running in background with ID: ${taskId}. Output is being written to: ${OUT_DIR}\\${taskId}.output. You will be notified when it completes. To check interim output, use Read on that file path.`,
                    is_error: false,
                },
            ],
        },
        toolUseResult: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
            backgroundTaskId: taskId,
        },
    });
}

function notification(taskId: string, toolUseId: string, status: string, summary: string): string {
    return [
        "<task-notification>",
        `<task-id>${taskId}</task-id>`,
        `<tool-use-id>${toolUseId}</tool-use-id>`,
        `<output-file>${OUT_DIR}\\${taskId}.output</output-file>`,
        `<status>${status}</status>`,
        `<summary>${summary}</summary>`,
        "</task-notification>",
    ].join("\n");
}

function enqueue(content: string): string {
    return JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-10-06T08:56:09.046Z",
        content,
    });
}

function userString(content: string): string {
    return JSON.stringify({ type: "user", timestamp: "2026-10-06T08:56:09.083Z", message: { role: "user", content } });
}

function toolResultTo(toolUseId: string, text = "ok") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] };
}

const startWait = [
    bashUse("toolu_01Ma", { command: "sleep 30", description: "Wait 30 seconds in the background" }),
    bashStart("toolu_01Ma", "bqjiuoxr7"),
];
const waitDone = notification(
    "bqjiuoxr7",
    "toolu_01Ma",
    "completed",
    'Background command "Wait 30 seconds in the background" completed (exit code 0)'
);

describe("extractShellTasks", () => {
    it("lists a running task with its description, command, start time and output path", () => {
        expect(extractShellTasks(startWait)).toEqual([
            {
                id: "bqjiuoxr7",
                description: "Wait 30 seconds in the background",
                command: "sleep 30",
                startedTs: Date.parse("2026-10-06T08:55:39.046Z"),
                outputPath: `${OUT_DIR}\\bqjiuoxr7.output`,
            },
        ]);
    });

    it("drops a task a queue-operation enqueue reports completed", () => {
        expect(extractShellTasks([...startWait, enqueue(waitDone)])).toEqual([]);
    });

    it("drops a task a user-role notification reports completed", () => {
        expect(extractShellTasks([...startWait, userString(waitDone)])).toEqual([]);
    });

    it("ignores a queue-operation remove", () => {
        const remove = JSON.stringify({ type: "queue-operation", operation: "remove", content: waitDone });
        expect(extractShellTasks([...startWait, remove]).map((t) => t.id)).toEqual(["bqjiuoxr7"]);
    });

    it("drops a failed task as it does a completed one", () => {
        const lines = [
            bashUse("toolu_01Jt", { command: "find / -name '*.db'", description: "Find wave SQLite database files" }),
            bashStart("toolu_01Jt", "bk9lllfkv"),
            userString(
                notification(
                    "bk9lllfkv",
                    "toolu_01Jt",
                    "failed",
                    'Background command "Find wave SQLite database files" failed with exit code 1'
                )
            ),
        ];
        expect(extractShellTasks(lines)).toEqual([]);
    });

    it("drops a task the agent killed from another command, which claude reports failed with exit code 127", () => {
        const failed = notification(
            "bqjiuoxr7",
            "toolu_01Ma",
            "failed",
            'Background command "Wait 30 seconds in the background" failed with exit code 127'
        );
        expect(extractShellTasks([...startWait, enqueue(failed)])).toEqual([]);
        expect(extractShellTasks([...startWait, enqueue(failed), userString(failed)])).toEqual([]);
    });

    it("drops a killed task", () => {
        const killed = notification(
            "bqjiuoxr7",
            "toolu_01Ma",
            "killed",
            'Background command "Wait 30 seconds in the background" was stopped because the system is running low on memory'
        );
        expect(extractShellTasks([...startWait, userString(killed)])).toEqual([]);
    });

    it("drops a task the agent stopped with TaskStop, which writes no notification", () => {
        const stop = JSON.stringify({
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "tool_use", id: "toolu_02St", name: "TaskStop", input: { task_id: "bqjiuoxr7" } }],
            },
        });
        const stopped = JSON.stringify({
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        tool_use_id: "toolu_02St",
                        type: "tool_result",
                        content: '{"message":"Successfully stopped task: bqjiuoxr7 (sleep 30)","task_id":"bqjiuoxr7"}',
                    },
                ],
            },
            toolUseResult: {
                message: "Successfully stopped task: bqjiuoxr7 (sleep 30)",
                task_id: "bqjiuoxr7",
                task_type: "local_bash",
                command: "sleep 30",
            },
        });
        expect(extractShellTasks([...startWait, stop, stopped])).toEqual([]);
    });

    it("drops a task stopped when the previous session ended, including the multi-task form with no task-id", () => {
        const single = notification(
            "bqjiuoxr7",
            "toolu_01Ma",
            "stopped",
            "Background shell command didn't finish before the previous session ended"
        );
        expect(extractShellTasks([...startWait, enqueue(single)])).toEqual([]);
        const multi = [
            "<task-notification>",
            "<status>stopped</status>",
            "<summary>2 background shell command tasks didn't finish before the previous session ended. Task ids: blostqclu, bqjiuoxr7.</summary>",
            "</task-notification>",
        ].join("\n");
        expect(extractShellTasks([...startWait, enqueue(multi)])).toEqual([]);
    });

    it("settles a task whose enqueue is written before its start record", () => {
        // a task that finishes at once: the enqueue lands one line ahead of the start's tool_result
        expect(extractShellTasks([startWait[0], enqueue(waitDone), startWait[1]])).toEqual([]);
    });

    it("ignores a notification for an id with no Bash start", () => {
        const agentDone = notification("a1b2c3", "toolu_02Ag", "completed", 'Agent "Review the diff" finished');
        expect(extractShellTasks([...startWait, enqueue(agentDone), userString(agentDone)]).map((t) => t.id)).toEqual([
            "bqjiuoxr7",
        ]);
        expect(extractShellTasks([enqueue(waitDone)])).toEqual([]);
    });

    it("ignores a Monitor event, which carries no status", () => {
        const event =
            '<task-notification>\n<task-id>bqjiuoxr7</task-id>\n<summary>Monitor event: "x"</summary>\n<event>done</event>\n</task-notification>';
        expect(extractShellTasks([...startWait, userString(event)]).map((t) => t.id)).toEqual(["bqjiuoxr7"]);
    });

    it("falls back to the command cut to 60 characters when there is no description", () => {
        const command = "npx vitest run frontend/app/view/agents/shelltasks.test.ts --reporter=verbose";
        const tasks = extractShellTasks([bashUse("toolu_03Nd", { command }), bashStart("toolu_03Nd", "bnodesc01")]);
        expect(tasks[0].description).toBe(command.slice(0, 60));
        expect(tasks[0].description).toHaveLength(60);
    });

    it("lists two tasks in start order and drops the one that finished", () => {
        const lines = [
            bashUse("toolu_04A", { command: "task dev", description: "Run the dev app" }),
            bashStart("toolu_04A", "bdevapp01", "2026-10-06T08:00:00.000Z"),
            ...startWait,
            bashUse("toolu_04C", { command: "go test ./pkg/x", description: "Test pkg x" }),
            bashStart("toolu_04C", "bgotest01", "2026-10-06T09:00:00.000Z"),
            enqueue(waitDone),
        ];
        expect(extractShellTasks(lines).map((t) => t.id)).toEqual(["bdevapp01", "bgotest01"]);
    });

    it("reads a task whose stdout is redirected from the redirect target instead", () => {
        const command = "tail -f /dev/null | task dev > /tmp/taskdev.log 2>&1";
        const start = JSON.parse(bashStart("toolu_05R", "bredir001"));
        start.cwd = "C:\\Users\\kael02\\IdeaProjects\\waveterm";
        const tasks = extractShellTasks([
            bashUse("toolu_05R", { command, description: "Launch the dev app in the background" }),
            JSON.stringify(start),
        ]);
        expect(tasks[0].outputPath).toBe("/tmp/taskdev.log");
    });

    it("skips unparseable lines", () => {
        expect(extractShellTasks(["not json", "", "null", ...startWait, "{truncated"]).map((t) => t.id)).toEqual([
            "bqjiuoxr7",
        ]);
    });
});

describe("extractShellTasks record shapes", () => {
    const ids = (lines: string[]) => extractShellTasks(lines).map((t) => t.id);
    const startRec = (over: Record<string, unknown>) =>
        JSON.stringify({
            type: "user",
            timestamp: "2026-10-06T08:55:39.046Z",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }] },
            toolUseResult: { backgroundTaskId: "bnew001" },
            ...over,
        });

    it("starts nothing from an ordinary tool result, which carries no background task id", () => {
        const ordinary = JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_y", content: "done" }] },
            toolUseResult: { stdout: "done" },
        });
        expect(extractShellTasks([...startWait, ordinary])).toEqual([expect.objectContaining({ id: "bqjiuoxr7" })]);
        expect(extractShellTasks([ordinary])).toEqual([]);
    });

    it("starts nothing from an empty background task id", () => {
        expect(extractShellTasks([startRec({ toolUseResult: { backgroundTaskId: "" } })])).toEqual([]);
    });

    it("starts nothing from a record whose content is not a list of blocks", () => {
        expect(ids([startRec({ message: { role: "user", content: "text" } })])).toEqual([]);
        expect(ids([startRec({ message: { role: "user" } })])).toEqual([]);
    });

    it("starts a task only from a user record", () => {
        expect(ids([startRec({ type: "system" })])).toEqual([]);
        expect(ids([startRec({ type: "user" })])).toEqual(["bnew001"]);
    });

    it("finds the tool result among the blocks of its record, not just the first block", () => {
        const lines = [
            bashUse("toolu_06B", { command: "sleep 9", description: "Sleep nine" }),
            startRec({
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "note" },
                        { type: "tool_result", tool_use_id: "toolu_06B", content: "started" },
                    ],
                },
            }),
        ];
        expect(extractShellTasks(lines)).toEqual([
            {
                id: "bnew001",
                description: "Sleep nine",
                command: "sleep 9",
                startedTs: Date.parse("2026-10-06T08:55:39.046Z"),
            },
        ]);
    });

    it("takes a tool use from an assistant tool_use block only", () => {
        const imposter = JSON.stringify({
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "text", id: "toolu_07I", input: { command: "echo hi", description: "imposter" } }],
            },
        });
        const start = startRec({
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_07I", content: "ok" }] },
        });
        expect(extractShellTasks([imposter, start])[0].description).toBe("");
    });

    it("does not file a tool_use block with no id under a missing tool_use_id", () => {
        const idless = JSON.stringify({
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi", description: "ghost" } }],
            },
        });
        const start = startRec({ message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
        expect(extractShellTasks([idless, start])[0].description).toBe("");
    });

    it("describes a task by its trimmed description, else the command, and omits a command it never had", () => {
        const described = (input: Record<string, unknown>) =>
            extractShellTasks([bashUse("toolu_08D", input), startRec({ message: toolResultTo("toolu_08D") })])[0];
        expect(described({ command: "make all", description: "  Build it  " }).description).toBe("Build it");
        expect(described({ command: "make all", description: "   " }).description).toBe("make all");
        expect(described({ command: "make all", description: 5 }).description).toBe("make all");
        expect(described({ description: "Only described" })).toStrictEqual({
            id: "bnew001",
            description: "Only described",
            startedTs: Date.parse("2026-10-06T08:55:39.046Z"),
        });
    });

    it("takes the start time only from a string timestamp", () => {
        expect(extractShellTasks([startRec({ timestamp: 5 })])[0]).not.toHaveProperty("startedTs");
        expect(extractShellTasks([startRec({ timestamp: undefined })])[0]).not.toHaveProperty("startedTs");
        expect(extractShellTasks([startRec({ timestamp: "not a date" })])[0]).not.toHaveProperty("startedTs");
    });

    it("joins a relative redirect to the record's cwd, and ignores a cwd that is not a string", () => {
        const lines = (cwd: unknown) => [
            bashUse("toolu_09C", { command: "task dev > out.log" }),
            startRec({ cwd, message: toolResultTo("toolu_09C", "Output is being written to: /claude/b.output.") }),
        ];
        expect(extractShellTasks(lines("C:\\repo"))[0].outputPath).toBe("C:\\repo/out.log");
        expect(extractShellTasks(lines(42))[0].outputPath).toBe("/claude/b.output");
        expect(extractShellTasks(lines(undefined))[0].outputPath).toBe("/claude/b.output");
    });

    it("reads claude's output file from a result that ends at the path's period", () => {
        const lines = [
            bashUse("toolu_10O", { command: "sleep 5" }),
            startRec({ message: toolResultTo("toolu_10O", "Output is being written to: /claude/tasks/b1.output.") }),
        ];
        expect(extractShellTasks(lines)[0].outputPath).toBe("/claude/tasks/b1.output");
    });

    it("lists no output path for a start with no redirect and no output notice", () => {
        expect(extractShellTasks([startRec({})])[0]).not.toHaveProperty("outputPath");
    });

    it("ignores a toolUseResult task_id on a record that is not a user record", () => {
        const stray = JSON.stringify({ type: "system", toolUseResult: { task_id: "bqjiuoxr7" } });
        expect(ids([...startWait, stray])).toEqual(["bqjiuoxr7"]);
    });

    it("lets a TaskStop result for a task that is not running leave the rest of its record to be read", () => {
        const both = startRec({ toolUseResult: { task_id: "bnotrunning", backgroundTaskId: "bnew002" } });
        expect(ids([both])).toEqual(["bnew002"]);
    });
});

describe("extractShellTasks finish notifications", () => {
    const ids = (lines: string[]) => extractShellTasks(lines).map((t) => t.id);

    it("takes a finish only from a queue-operation enqueue with string content", () => {
        const wrongType = JSON.stringify({ type: "summary", operation: "enqueue", content: waitDone });
        const objectContent = JSON.stringify({
            type: "queue-operation",
            operation: "enqueue",
            content: { text: waitDone },
        });
        expect(ids([...startWait, wrongType, objectContent])).toEqual(["bqjiuoxr7"]);
    });

    it("takes a finish only from a user record whose message content is a string", () => {
        const wrongType = JSON.stringify({ type: "system", message: { role: "user", content: waitDone } });
        const objectContent = JSON.stringify({ type: "user", message: { role: "user", content: { text: waitDone } } });
        const noMessage = JSON.stringify({ type: "user", toolUseResult: { stdout: "x" } });
        expect(ids([...startWait, wrongType, objectContent, noMessage])).toEqual(["bqjiuoxr7"]);
    });

    it("matches a task id with a dot in it whole when a dead session lists it", () => {
        const dotted = [bashUse("toolu_11D", { command: "sleep 1" }), bashStart("toolu_11D", "b.dot1")];
        const multi = [
            "<task-notification>",
            "<status>stopped</status>",
            "<summary>1 background shell command task didn't finish. Task ids: b.dot1.</summary>",
            "</task-notification>",
        ].join("\n");
        expect(ids([...dotted, enqueue(multi)])).toEqual([]);
    });
});

describe("redirectTarget", () => {
    const CWD = "C:\\repo";
    it.each([
        ["task dev > /tmp/taskdev.log 2>&1", "/tmp/taskdev.log"],
        ["task dev >/tmp/a.log", "/tmp/a.log"],
        ["task dev >> /tmp/a.log", "/tmp/a.log"],
        ["task dev 1> /tmp/a.log 2> /tmp/b.log", "/tmp/a.log"],
        ["task dev &> /tmp/a.log", "/tmp/a.log"],
        ["task dev > ~/logs/a.log", "~/logs/a.log"],
        ["task dev > C:\\logs\\a.log", "C:\\logs\\a.log"],
        ['task dev > "/tmp/my log.txt"', "/tmp/my log.txt"],
        ["task dev > out.log", "C:\\repo/out.log"],
        ["echo a > /tmp/first.log; task dev > /tmp/second.log", "/tmp/second.log"],
        ['tail -f /dev/null | task dev > "$TEMP/claude/dev.log" 2>&1', "$TEMP/claude/dev.log"],
        ["flutter analyze > ${TMPDIR}/a.log", "${TMPDIR}/a.log"],
        ["task dev > $TMP\\a.log", "$TMP\\a.log"],
        ['cd "$TEMP/g9-prod" && python g9.py > g9.log 2>&1; grep x g9.log', "$TEMP/g9-prod/g9.log"],
        ["cd sub && task dev > out.log", "C:\\repo/sub/out.log"],
        ["cd /c/work && cd logs && task dev > out.log", "/c/work/logs/out.log"],
        ["cd /c/work && task dev > /tmp/a.log", "/tmp/a.log"],
        ["task dev > out.log; cd /c/elsewhere", "C:\\repo/out.log"],
    ])("%s -> %s", (command, want) => {
        expect(redirectTarget(command, CWD)).toBe(want);
    });

    it.each([
        "task dev",
        "task dev 2> /tmp/err.log",
        "task dev 2>&1",
        "task dev >&2",
        "task dev > /dev/null 2>&1",
        "task dev > NUL",
        "task dev | tee /tmp/a.log",
        'node -e "if (a > b) process.exit(1)"',
        "node -e 'console.log(1 > 0)'",
        "task dev > $LOG",
        "task dev > $TEMPLATE/a.log",
        "task dev > $TEMP/$NAME.log",
        "cd $DIR && task dev > out.log",
        "cd - && task dev > out.log",
    ])("%s has no readable redirect", (command) => {
        expect(redirectTarget(command, CWD)).toBeUndefined();
    });

    it("leaves a relative target unresolved without a cwd", () => {
        expect(redirectTarget("task dev > out.log", undefined)).toBeUndefined();
    });
});

describe("isStandingBy", () => {
    const running: ShellTask[] = [{ id: "a", description: "a" }];

    it("is true only for idle with a running task", () => {
        expect(isStandingBy("idle", running)).toBe(true);
    });

    it("is false for idle with no running task", () => {
        expect(isStandingBy("idle", [])).toBe(false);
    });

    it("is false while working or asking, with or without a running task", () => {
        for (const state of ["working", "asking"]) {
            expect(isStandingBy(state, running)).toBe(false);
            expect(isStandingBy(state, [])).toBe(false);
        }
    });
});

describe("shellKillNote", () => {
    it("says nothing for a kill, since the row leaving says it", () => {
        expect(shellKillNote({ outcome: "killed", killed: 2 }, "Run the dev app")).toBeNull();
    });

    it("names the task for every other outcome, with the OS text on a failure", () => {
        expect(shellKillNote({ outcome: "gone", killed: 0 }, "Run the dev app")).toBe(
            '"Run the dev app" had already ended.'
        );
        expect(shellKillNote({ outcome: "failed", killed: 0, error: "Access is denied." }, "Run the dev app")).toBe(
            'Could not kill "Run the dev app": Access is denied.'
        );
        expect(shellKillNote({ outcome: "refused", killed: 0 }, "Run the dev app")).toMatch(/^Not killed: /);
    });
});

describe("shellTasksLabel", () => {
    it("pluralizes", () => {
        expect(shellTasksLabel(1)).toBe("1 shell task");
        expect(shellTasksLabel(3)).toBe("3 shell tasks");
    });
});

describe("outputTail", () => {
    it("returns short output whole", () => {
        expect(outputTail(["[exited with code 0]"])).toEqual(["[exited with code 0]"]);
        expect(outputTail([])).toEqual([]);
    });

    it("cuts to the last maxChars and drops the fragment of the line the cut lands in", () => {
        // joined: "aaaa\nbbbb\ncccc" (14 chars); the last 7 are "bb\ncccc"
        expect(outputTail(["aaaa", "bbbb", "cccc"], 7)).toEqual(["cccc"]);
    });

    it("keeps a whole first line when the cut lands on a line start", () => {
        // the last 9 are "bbbb\ncccc"
        expect(outputTail(["aaaa", "bbbb", "cccc"], 9)).toEqual(["bbbb", "cccc"]);
    });

    it("keeps the tail of a single line longer than the cap", () => {
        expect(outputTail(["x".repeat(10) + "tail"], 4)).toEqual(["tail"]);
    });

    it("defaults to 64 KB, keeping the newest lines", () => {
        const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
        const tail = outputTail(lines);
        expect(tail.join("\n").length).toBeLessThanOrEqual(64 * 1024);
        expect(tail.length).toBeLessThan(lines.length);
        expect(tail.at(-1)).toBe(lines.at(-1));
    });
});
