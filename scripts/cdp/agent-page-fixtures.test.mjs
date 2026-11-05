import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    assistantText,
    interrupted,
    taskNotification,
    toolResult,
    toolUse,
    usage,
    userText,
    writeSubagent,
    writeTranscript,
} from "./agent-page-fixtures.mjs";

const dirs = [];
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-agent-fixtures-"));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("record builders", () => {
    it("each builder emits one parseable JSON line", () => {
        const lines = [
            userText("hi"),
            assistantText("hello"),
            toolUse("toolu_1", "Bash", { command: "ls" }),
            toolResult("toolu_1", "ok"),
            taskNotification({ taskId: "t1", toolUseId: "toolu_1", status: "completed", summary: "done" }),
            interrupted(),
            usage({ input: 1, output: 2 }),
        ];
        for (const line of lines) {
            expect(line).not.toContain("\n");
            const rec = JSON.parse(line);
            expect(rec.timestamp).toBeTruthy();
            expect(rec.cwd).toBeTruthy();
            expect(rec.sessionId).toBeTruthy();
        }
    });

    it("honours the cwd, sessionId and ts options", () => {
        const rec = JSON.parse(userText("hi", { cwd: "C:\\x", sessionId: "s1", ts: "2026-11-05T00:00:00.000Z" }));
        expect(rec).toMatchObject({ cwd: "C:\\x", sessionId: "s1", timestamp: "2026-11-05T00:00:00.000Z" });
    });

    it("taskNotification carries task-id, tool-use-id and status", () => {
        const text = JSON.parse(
            taskNotification({ taskId: "t1", toolUseId: "toolu_9", status: "killed", summary: "stopped" })
        ).message.content;
        expect(text).toContain("<task-notification>");
        expect(text).toContain("<task-id>t1</task-id>");
        expect(text).toContain("<tool-use-id>toolu_9</tool-use-id>");
        expect(text).toContain("<status>killed</status>");
        expect(text).toContain("<summary>stopped</summary>");
    });

    it("toolResult keeps toolUseResult", () => {
        const rec = JSON.parse(toolResult("toolu_1", "ack", { toolUseResult: { agentId: "a1" }, isError: true }));
        expect(rec.toolUseResult).toEqual({ agentId: "a1" });
        expect(rec.message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: true });
        expect(JSON.parse(toolResult("toolu_1", "ack"))).not.toHaveProperty("toolUseResult");
    });

    it("usage carries the token counts and model", () => {
        const rec = JSON.parse(usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: "m" }));
        expect(rec.message.model).toBe("m");
        expect(rec.message.usage).toEqual({
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
        });
    });
});

describe("writers", () => {
    it("writeTranscript writes <dir>/<name>.jsonl", () => {
        const dir = tmp();
        const path = writeTranscript(dir, "parent", [userText("a"), assistantText("b")]);
        expect(path).toBe(join(dir, "parent.jsonl"));
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    });

    it("writeSubagent puts the child under <name>/subagents", () => {
        const dir = tmp();
        const path = writeSubagent(dir, "parent", "a1", [userText("child")]);
        expect(path).toBe(join(dir, "parent", "subagents", "agent-a1.jsonl"));
        expect(JSON.parse(readFileSync(path, "utf8").trim()).message.content).toBe("child");
    });
});
