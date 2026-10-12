// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    extractShellTasks,
    failedLabel,
    isFailedExitLine,
    isStandingBy,
    outputTail,
    shellTaskStatus,
    shellTasksLabel,
    visibleShellTasks,
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
    it("lists a running task with its description, start time and output path", () => {
        expect(extractShellTasks(startWait)).toEqual([
            {
                id: "bqjiuoxr7",
                description: "Wait 30 seconds in the background",
                state: "running",
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
        expect(extractShellTasks([...startWait, remove]).map((t) => t.state)).toEqual(["running"]);
    });

    it("keeps a failed task with the exit code from its summary", () => {
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
        expect(extractShellTasks(lines)).toEqual([
            expect.objectContaining({
                id: "bk9lllfkv",
                description: "Find wave SQLite database files",
                state: "failed",
                exitCode: 1,
            }),
        ]);
    });

    it("lets the later notification win when both shapes arrive", () => {
        const failed = notification(
            "bqjiuoxr7",
            "toolu_01Ma",
            "failed",
            'Background command "x" failed with exit code 2'
        );
        expect(extractShellTasks([...startWait, enqueue(failed), userString(waitDone)])).toEqual([]);
        expect(extractShellTasks([...startWait, enqueue(waitDone), userString(failed)])).toEqual([
            expect.objectContaining({ state: "failed", exitCode: 2 }),
        ]);
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
        expect(extractShellTasks([...startWait, userString(event)]).map((t) => t.state)).toEqual(["running"]);
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

    it("skips unparseable lines", () => {
        expect(extractShellTasks(["not json", "", "null", ...startWait, "{truncated"]).map((t) => t.id)).toEqual([
            "bqjiuoxr7",
        ]);
    });
});

describe("visibleShellTasks", () => {
    it("keeps running and failed tasks", () => {
        const tasks: ShellTask[] = [
            { id: "a", description: "a", state: "running" },
            { id: "b", description: "b", state: "failed", exitCode: 1 },
        ];
        expect(visibleShellTasks(tasks)).toEqual(tasks);
    });
});

describe("isStandingBy", () => {
    const running: ShellTask[] = [{ id: "a", description: "a", state: "running" }];
    const failedOnly: ShellTask[] = [{ id: "b", description: "b", state: "failed", exitCode: 1 }];

    it("is true only for idle with a running task", () => {
        expect(isStandingBy("idle", running)).toBe(true);
        expect(isStandingBy("idle", [...failedOnly, ...running])).toBe(true);
    });

    it("is false for idle with no running task", () => {
        expect(isStandingBy("idle", [])).toBe(false);
        expect(isStandingBy("idle", failedOnly)).toBe(false);
    });

    it("is false while working or asking, with or without a running task", () => {
        for (const state of ["working", "asking"]) {
            expect(isStandingBy(state, running)).toBe(false);
            expect(isStandingBy(state, [])).toBe(false);
        }
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

describe("shellTaskStatus", () => {
    const running: ShellTask = { id: "t1", description: "d", state: "running" };
    const failed: ShellTask = { id: "t2", description: "d", state: "failed", exitCode: 2 };

    it("reads a running task as running and live", () => {
        expect(shellTaskStatus(running, false)).toEqual({ label: "running", tone: "accent", live: true });
    });

    it("reads a failed task with its exit code, not live", () => {
        expect(shellTaskStatus(failed, false)).toEqual({ label: "failed · exit 2", tone: "error", live: false });
        expect(failedLabel({ ...failed, exitCode: undefined })).toBe("failed");
    });

    it("reads a task that left the list as finished, not live, whatever its last state", () => {
        expect(shellTaskStatus(running, true)).toEqual({ label: "finished", tone: "muted", live: false });
    });
});

describe("isFailedExitLine", () => {
    it("marks a trailing nonzero exit line", () => {
        expect(isFailedExitLine("[exited with code 1]", true)).toBe(true);
        expect(isFailedExitLine("  [exited with code -1] ", true)).toBe(true);
    });

    it("leaves a zero exit, an earlier line, and ordinary output unmarked", () => {
        expect(isFailedExitLine("[exited with code 0]", true)).toBe(false);
        expect(isFailedExitLine("[exited with code 1]", false)).toBe(false);
        expect(isFailedExitLine("exited with code 1", true)).toBe(false);
    });
});
