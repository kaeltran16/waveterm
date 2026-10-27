// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    extractShellTasks,
    isStandingBy,
    monitorEventsSummary,
    monitorExpiresAt,
    monitorOutputPath,
    monitorSubline,
    monitorTimeLeft,
    outputTail,
    redirectTarget,
    shellKillNote,
    shellTasksLabel,
    shellTasksNoun,
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

function monitorUse(toolUseId: string, input: Record<string, unknown>): string {
    return JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-27T09:00:00.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Monitor", input }] },
    });
}

function monitorStart(
    toolUseId: string,
    taskId: string,
    { timestamp = "2026-10-27T09:00:01.000Z", timeoutMs = 1800000, persistent = false } = {}
): string {
    return JSON.stringify({
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Monitor started (task ${taskId}, expires in 30m unless the source ends first; events arrive as notifications)`,
                },
            ],
        },
        toolUseResult: { taskId, timeoutMs, persistent },
    });
}

function monitorEvent(taskId: string, desc: string, lines: string[]): string {
    return [
        "<task-notification>",
        `<task-id>${taskId}</task-id>`,
        `<summary>Monitor event: "${desc}"</summary>`,
        `<event>${lines.join("\n")}</event>`,
        "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
        "</task-notification>",
    ].join("\n");
}

function monitorEnd(taskId: string, toolUseId: string, desc: string): string {
    return notification(taskId, toolUseId, "completed", `Monitor "${desc}" stream ended`);
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

function enqueue(content: string, timestamp = "2026-10-06T08:56:09.046Z"): string {
    return JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp, content });
}

function userString(content: string, timestamp = "2026-10-06T08:56:09.083Z"): string {
    return JSON.stringify({ type: "user", timestamp, message: { role: "user", content } });
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
                kind: "shell",
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
                kind: "shell",
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
            kind: "shell",
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

describe("extractShellTasks monitors", () => {
    const TRANSCRIPT = "C:\\Users\\kael02\\.claude\\projects\\C--Users-kael02-IdeaProjects-waveterm\\5e1f0c2a.jsonl";
    const START = Date.parse("2026-10-27T09:00:01.000Z");
    const DESC = "Watch the dev log for errors";
    const COMMAND = "tail -f /tmp/dev.log | grep --line-buffered ERROR";
    const startLogs = [
        monitorUse("toolu_M1", { description: DESC, timeout_ms: 1800000, command: COMMAND }),
        monitorStart("toolu_M1", "mlogs001"),
    ];
    const ev1 = monitorEvent("mlogs001", DESC, ["ERROR one", "ERROR two"]);
    const extract = (lines: string[], now = START + 1000) =>
        extractShellTasks(lines, { now, transcriptPath: TRANSCRIPT });
    const eventCount = (lines: string[]) => extract(lines)[0]?.events?.length;

    it("a Monitor start lists a monitor", () => {
        expect(extract(startLogs)).toEqual([
            {
                id: "mlogs001",
                kind: "monitor",
                description: DESC,
                command: COMMAND,
                startedTs: START,
                timeoutMs: 1800000,
                persistent: false,
                events: [],
                outputPath: "$TEMP/claude/C--Users-kael02-IdeaProjects-waveterm/5e1f0c2a/tasks/mlogs001.output",
            },
        ]);
    });

    it("lists no output path without a transcript path", () => {
        expect(extractShellTasks(startLogs, { now: START })[0]).not.toHaveProperty("outputPath");
    });

    it("each event counts once", () => {
        const events = extract([
            ...startLogs,
            enqueue(ev1, "2026-10-27T09:01:00.000Z"),
            userString(ev1, "2026-10-27T09:01:00.050Z"),
        ])[0].events;
        expect(events).toEqual([{ ts: Date.parse("2026-10-27T09:01:00.000Z"), lines: ["ERROR one", "ERROR two"] }]);
    });

    it("an event delivered mid-turn counts once", () => {
        const remove = JSON.stringify({
            type: "queue-operation",
            operation: "remove",
            timestamp: "2026-10-27T09:01:01.000Z",
        });
        const attachment = JSON.stringify({
            type: "attachment",
            timestamp: "2026-10-27T09:01:01.000Z",
            attachment: { type: "queued_command", prompt: ev1, commandMode: "task-notification" },
        });
        expect(eventCount([...startLogs, enqueue(ev1), remove, attachment])).toBe(1);
    });

    it("a user-record event with no enqueue counts", () => {
        const events = extract([...startLogs, userString(ev1, "2026-10-27T09:02:00.000Z")])[0].events;
        expect(events).toEqual([{ ts: Date.parse("2026-10-27T09:02:00.000Z"), lines: ["ERROR one", "ERROR two"] }]);
    });

    it("two identical events both count", () => {
        expect(eventCount([...startLogs, enqueue(ev1), enqueue(ev1), userString(ev1), userString(ev1)])).toBe(2);
        expect(eventCount([...startLogs, enqueue(ev1), userString(ev1), enqueue(ev1), userString(ev1)])).toBe(2);
    });

    it("matches a user-record copy to its enqueue by body", () => {
        const ev2 = monitorEvent("mlogs001", DESC, ["ERROR three"]);
        expect(eventCount([...startLogs, enqueue(ev1), userString(ev2), userString(ev1)])).toBe(2);
    });

    it("a stream-ended notification drops a monitor", () => {
        expect(extract([...startLogs, enqueue(ev1), enqueue(monitorEnd("mlogs001", "toolu_M1", DESC))])).toEqual([]);
        expect(extract([...startLogs, userString(monitorEnd("mlogs001", "toolu_M1", DESC))])).toEqual([]);
    });

    it("a TaskStop result drops a monitor", () => {
        const stopped = JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_St", content: "ok" }] },
            toolUseResult: { message: "Successfully stopped task: mlogs001", task_id: "mlogs001", command: COMMAND },
        });
        expect(extract([...startLogs, stopped])).toEqual([]);
    });

    it("a monitor past its timeout drops; a persistent one stays", () => {
        expect(extract(startLogs, START + 1800000)).toEqual([]);
        expect(extract(startLogs, START + 1800000 - 1).map((t) => t.id)).toEqual(["mlogs001"]);
        const persistent = [startLogs[0], monitorStart("toolu_M1", "mlogs001", { persistent: true })];
        expect(extract(persistent, START + 1800000 * 100).map((t) => t.persistent)).toEqual([true]);
    });

    it("keeps a monitor whose start time is unknown", () => {
        const start = JSON.parse(startLogs[1]);
        delete start.timestamp;
        expect(extract([startLogs[0], JSON.stringify(start)], START + 1800000 * 100)).toHaveLength(1);
    });

    it("a taskId result without timeoutMs is not a monitor", () => {
        const other = JSON.parse(startLogs[1]);
        delete other.toolUseResult.timeoutMs;
        expect(extract([startLogs[0], JSON.stringify(other)])).toEqual([]);
        const empty = JSON.parse(startLogs[1]);
        empty.toolUseResult.taskId = "";
        expect(extract([startLogs[0], JSON.stringify(empty)])).toEqual([]);
    });

    it("an event for an id with no start is ignored", () => {
        const stray = monitorEvent("mother01", "Other", ["x"]);
        expect(extract([enqueue(stray), userString(stray)])).toEqual([]);
        expect(eventCount([...startLogs, enqueue(stray), userString(stray)])).toBe(0);
    });

    it("shell tasks and monitors list in start order", () => {
        const lines = [
            bashUse("toolu_04A", { command: "task dev", description: "Run the dev app" }),
            bashStart("toolu_04A", "bdevapp01", "2026-10-27T08:59:00.000Z"),
            ...startLogs,
            bashUse("toolu_04C", { command: "go test ./pkg/x", description: "Test pkg x" }),
            bashStart("toolu_04C", "bgotest01", "2026-10-27T09:00:30.000Z"),
        ];
        expect(extract(lines).map((t) => [t.id, t.kind])).toEqual([
            ["bdevapp01", "shell"],
            ["mlogs001", "monitor"],
            ["bgotest01", "shell"],
        ]);
    });

    it("a ws monitor lists with no command", () => {
        const lines = [
            monitorUse("toolu_W1", { description: "Watch the socket", timeout_ms: 1800000, ws: { url: "ws://x" } }),
            monitorStart("toolu_W1", "mws00001"),
        ];
        const [t] = extract(lines);
        expect(t).toMatchObject({ id: "mws00001", kind: "monitor", description: "Watch the socket" });
        expect(t).not.toHaveProperty("command");
    });
});

describe("monitorOutputPath", () => {
    it("derives the output path over both separators", () => {
        const want = "$TEMP/claude/C--x/abc/tasks/m1.output";
        expect(monitorOutputPath("C:\\Users\\u\\.claude\\projects\\C--x\\abc.jsonl", "m1")).toBe(want);
        expect(monitorOutputPath("/c/Users/u/.claude/projects/C--x/abc.jsonl", "m1")).toBe(want);
    });

    it("gives nothing for a path that is not a transcript in a directory", () => {
        expect(monitorOutputPath("abc.jsonl", "m1")).toBeUndefined();
        expect(monitorOutputPath("C:\\x\\abc.txt", "m1")).toBeUndefined();
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
    const running: ShellTask[] = [{ id: "a", kind: "shell", description: "a" }];

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
    const shell = { kind: "shell", description: "Run the dev app" } as const;
    const monitor = { kind: "monitor", description: "Watch the log" } as const;

    it("says nothing for a kill, since the row leaving says it", () => {
        expect(shellKillNote({ outcome: "killed", killed: 2 }, shell)).toBeNull();
        expect(shellKillNote({ outcome: "killed", killed: 1 }, monitor)).toBeNull();
    });

    it("names the task for every other outcome, with the OS text on a failure", () => {
        expect(shellKillNote({ outcome: "gone", killed: 0 }, shell)).toBe('"Run the dev app" had already ended.');
        expect(shellKillNote({ outcome: "failed", killed: 0, error: "Access is denied." }, shell)).toBe(
            'Could not kill "Run the dev app": Access is denied.'
        );
        expect(shellKillNote({ outcome: "refused", killed: 0 }, shell)).toMatch(/^Not killed: /);
    });

    it("uses the stop copy for a monitor", () => {
        expect(shellKillNote({ outcome: "gone", killed: 0 }, monitor)).toBe('"Watch the log" had already ended.');
        expect(shellKillNote({ outcome: "failed", killed: 0, error: "Access is denied." }, monitor)).toBe(
            'Could not stop "Watch the log": Access is denied.'
        );
        expect(shellKillNote({ outcome: "refused", killed: 0 }, monitor)).toBe(
            'Not stopped: "Watch the log" is not a process of this agent\'s tab.'
        );
    });
});

describe("monitor labels", () => {
    const NOW = Date.parse("2026-10-27T10:00:00.000Z");
    const MIN = 60_000;
    const shellTask: ShellTask = { id: "s", kind: "shell", description: "s" };
    const monitor = (over: Partial<ShellTask> = {}): ShellTask => ({
        id: "m",
        kind: "monitor",
        description: "m",
        startedTs: NOW - 10 * MIN,
        timeoutMs: 30 * MIN,
        ...over,
    });
    const events = (...agoMs: number[]) => agoMs.map((ago) => ({ ts: NOW - ago, lines: ["x"] }));

    it("labels a list by its kinds", () => {
        expect(shellTasksLabel([shellTask])).toBe("1 shell task");
        expect(shellTasksLabel([shellTask, shellTask, shellTask])).toBe("3 shell tasks");
        expect(shellTasksLabel([monitor()])).toBe("1 monitor");
        expect(shellTasksLabel([monitor(), monitor()])).toBe("2 monitors");
        expect(shellTasksLabel([shellTask, monitor(), monitor()])).toBe("3 tasks");
        expect(shellTasksNoun([shellTask])).toBe("shell tasks");
        expect(shellTasksNoun([monitor()])).toBe("monitors");
        expect(shellTasksNoun([shellTask, monitor()])).toBe("tasks");
    });

    it("summarizes events, or nothing without any", () => {
        expect(monitorEventsSummary(monitor(), NOW)).toBeNull();
        expect(monitorEventsSummary(monitor({ events: events(3 * MIN) }), NOW)).toBe("1 event · 3m ago");
        expect(monitorEventsSummary(monitor({ events: events(5 * MIN, 0, 20_000, 10_000) }), NOW)).toBe(
            "4 events · just now"
        );
    });

    it("writes a row's second line", () => {
        expect(monitorSubline(monitor({ startedTs: NOW - 20_000 }), NOW)).toBe("no events yet · <1m");
        expect(monitorSubline(monitor({ events: events(30 * MIN, 20_000, 10_000, 0) }), NOW)).toBe(
            "4 events · just now"
        );
        const nine = events(...Array.from({ length: 9 }, (_, i) => (i === 8 ? 3 * MIN : 4 * MIN)));
        expect(monitorSubline(monitor({ persistent: true, events: nine }), NOW)).toBe("persistent · 9 events · 3m ago");
    });

    it("reads the time left, rounded up", () => {
        expect(monitorTimeLeft(monitor({ startedTs: NOW - 12.5 * MIN, timeoutMs: 30 * MIN }), NOW)).toBe("18m left");
        expect(monitorTimeLeft(monitor({ startedTs: NOW - 30 * MIN + 30_000 }), NOW)).toBe("<1m left");
        expect(monitorTimeLeft(monitor({ persistent: true }), NOW)).toBeNull();
        expect(monitorTimeLeft(monitor({ timeoutMs: undefined }), NOW)).toBeNull();
        expect(monitorTimeLeft(monitor({ startedTs: undefined }), NOW)).toBeNull();
    });

    it("derives the expiry from start and timeout", () => {
        expect(monitorExpiresAt(monitor())).toBe(NOW - 10 * MIN + 30 * MIN);
        expect(monitorExpiresAt(monitor({ persistent: true }))).toBeNull();
        expect(monitorExpiresAt(monitor({ timeoutMs: undefined }))).toBeNull();
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
