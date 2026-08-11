// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractPiTitle, projectPiTranscript } from "./pitranscriptprojection";

const L = JSON.stringify;
const session = L({
    type: "session",
    version: 3,
    id: "s1",
    timestamp: "2026-08-11T03:00:00Z",
    cwd: "/repo",
});

describe("projectPiTranscript", () => {
    it("projects only the active parent branch root-first, joining tool results to calls", () => {
        const lines = [
            session,
            L({ type: "message", id: "root", parentId: null, message: { role: "user", content: "implement it" } }),
            // abandoned sibling: on disk, never on the active chain
            L({
                type: "message",
                id: "abandoned",
                parentId: "root",
                message: { role: "assistant", content: "Approach A failed" },
            }),
            L({
                type: "message",
                id: "inspecting",
                parentId: "root",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Inspecting." },
                        { type: "tool_use", toolCallId: "t1", name: "Bash", args: { command: "go test ./pkg/..." } },
                    ],
                },
            }),
            L({
                type: "message",
                id: "tr1",
                parentId: "inspecting",
                message: { role: "toolResult", toolCallId: "t1", content: "ok" },
            }),
            L({
                type: "message",
                id: "approachb",
                parentId: "tr1",
                message: { role: "user", content: "use approach B" },
            }),
            L({
                type: "message",
                id: "final",
                parentId: "approachb",
                message: { role: "assistant", content: "Approach B works." },
            }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "implement it" },
            { kind: "message", text: "Inspecting." },
            { kind: "action", verb: "bash", target: "go test ./pkg/...", outcome: "ok" },
            { kind: "user", text: "use approach B" },
            { kind: "message", text: "Approach B works." },
        ]);
        expect(projectPiTranscript(lines).some((e) => JSON.stringify(e).includes("Approach A failed"))).toBe(false);
    });

    it("marks a failed tool call fail via the tool result's error flag", () => {
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: "build it" } }),
            L({
                type: "message",
                id: "a",
                parentId: "u",
                message: {
                    role: "assistant",
                    content: [{ type: "tool_use", toolCallId: "b1", name: "Bash", args: { command: "make build" } }],
                },
            }),
            L({
                type: "message",
                id: "r",
                parentId: "a",
                message: { role: "toolResult", toolCallId: "b1", content: "build failed", isError: true },
            }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "build it" },
            { kind: "action", verb: "bash", target: "make build", outcome: "fail" },
        ]);
    });

    it("maps compaction records to the compaction entry kind", () => {
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: "long task" } }),
            L({ type: "message", id: "a1", parentId: "u", message: { role: "assistant", content: "part one" } }),
            L({ type: "compaction", id: "c", parentId: "a1", timestamp: "2026-08-11T03:01:00Z" }),
            L({ type: "message", id: "a2", parentId: "c", message: { role: "assistant", content: "resumed" } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "long task" },
            { kind: "message", text: "part one" },
            { kind: "compaction" },
            { kind: "message", text: "resumed" },
        ]);
    });

    it("never renders branch_summary as content", () => {
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: "task" } }),
            L({
                type: "branch_summary",
                id: "bs",
                parentId: "u",
                timestamp: "2026-08-11T03:02:00Z",
                summary: "did things",
            }),
        ];
        const entries = projectPiTranscript(lines);
        expect(entries).toEqual([{ kind: "user", text: "task" }]);
        expect(entries.some((e) => JSON.stringify(e).includes("did things"))).toBe(false);
    });

    it("skips malformed lines and keeps the reachable branch", () => {
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: "keep me" } }),
            "{ this is not json",
            L({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "done" } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "keep me" },
            { kind: "message", text: "done" },
        ]);
    });

    it("terminates on a parent cycle and projects the reachable suffix", () => {
        const lines = [
            session,
            L({ type: "message", id: "a", parentId: "b", message: { role: "assistant", content: "one" } }),
            L({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "two" } }),
        ];
        expect(() => projectPiTranscript(lines)).not.toThrow();
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "message", text: "one" },
            { kind: "message", text: "two" },
        ]);
    });
});

describe("extractPiTitle", () => {
    it("uses the latest session_info name on the active branch", () => {
        const lines = [
            session,
            L({ type: "session_info", id: "si1", parentId: null, name: "old title" }),
            L({ type: "message", id: "u", parentId: "si1", message: { role: "user", content: "task" } }),
            L({ type: "session_info", id: "si2", parentId: "u", name: "new title" }),
        ];
        expect(extractPiTitle(lines)).toBe("new title");
    });

    it("falls back to the first active user text", () => {
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: "fix the bug" } }),
        ];
        expect(extractPiTitle(lines)).toBe("fix the bug");
    });
});
