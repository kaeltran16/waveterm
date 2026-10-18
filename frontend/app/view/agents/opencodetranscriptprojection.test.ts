// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractOpencodeTitle, projectOpencodeTranscript } from "./opencodetranscriptprojection";

const SHADOW = [
    `{"type":"session","id":"ses_x","model":"openai/gpt-5.2-codex","title":"Fix the flaky test","ts":100}`,
    `{"type":"state","state":"working","ts":101}`,
    `{"type":"user","text":"fix the flaky test","ts":102}`,
    `{"type":"assistant","text":"Looking at the spec…","ts":103}`,
    `{"type":"tool","name":"bash","state":"running","input":"go test ./...","ts":104}`,
    `{"type":"tool","name":"bash","state":"error","input":"go test ./...","ts":105}`,
];

describe("projectOpencodeTranscript", () => {
    it("projects user/assistant/tool lines into entries", () => {
        const entries = projectOpencodeTranscript(SHADOW);
        expect(entries[0]).toEqual({ kind: "user", text: "fix the flaky test" });
        expect(entries[1]).toEqual({ kind: "message", text: "Looking at the spec…" });
        expect(entries[2]).toMatchObject({ kind: "action", verb: "ran", target: "go test ./...", outcome: "ok" });
        expect(entries[3]).toMatchObject({ kind: "action", verb: "ran", target: "go test ./...", outcome: "fail" });
    });
    it("skips state records and unparseable lines", () => {
        const entries = projectOpencodeTranscript([...SHADOW, "not json"]);
        expect(entries.some((e) => (e as any).kind === "state")).toBe(false);
    });
    it("maps edit/write/read tool targets to a file name", () => {
        const entries = projectOpencodeTranscript([
            `{"type":"tool","name":"edit","state":"completed","input":"{\\"filePath\\":\\"/a/b/auth.go\\"}","ts":1}`,
        ]);
        expect(entries[0]).toMatchObject({ kind: "action", verb: "edited", target: "auth.go" });
    });
    it("projects exactly the user, assistant and tool records of a session, in order", () => {
        expect(projectOpencodeTranscript(SHADOW)).toStrictEqual([
            { kind: "user", text: "fix the flaky test" },
            { kind: "message", text: "Looking at the spec…" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "ok" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "fail" },
        ]);
    });
    it("skips a user or assistant record whose text is blank or not a string", () => {
        expect(
            projectOpencodeTranscript([
                `{"type":"user","text":"   "}`,
                `{"type":"user","text":5}`,
                `{"type":"user"}`,
                `{"type":"assistant","text":"  \\n"}`,
                `{"type":"assistant","text":5}`,
                `{"type":"assistant"}`,
            ])
        ).toStrictEqual([]);
    });
    it("reads text only from user and assistant records, and a name only from tool records", () => {
        expect(
            projectOpencodeTranscript([
                `{"type":"state","state":"working","text":"hello"}`,
                `{"type":"session","name":"n","text":"hello"}`,
                `{"type":"user","name":"bash","input":"ls"}`,
                `{"type":"tool","text":"hello"}`,
            ])
        ).toStrictEqual([]);
    });
    it("labels a bash call by its raw input whatever that input looks like, and by nothing when it has none", () => {
        expect(
            projectOpencodeTranscript([
                `{"type":"tool","name":"bash","state":"running","input":"{\\"filePath\\":\\"/a/b.go\\"}"}`,
                `{"type":"tool","name":"bash","state":"running"}`,
            ])
        ).toStrictEqual([
            { kind: "action", verb: "ran", target: '{"filePath":"/a/b.go"}', outcome: "ok" },
            { kind: "action", verb: "ran", target: "" },
        ]);
    });
    it("labels a non-bash call with no input by its tool name, and sets no outcome", () => {
        expect(projectOpencodeTranscript([`{"type":"tool","name":"read","state":"completed"}`])).toStrictEqual([
            { kind: "action", verb: "read", target: "read" },
        ]);
    });
    it("sets an outcome only on a bash call", () => {
        const input = JSON.stringify({ filePath: "/a/b.go" });
        expect(
            projectOpencodeTranscript([JSON.stringify({ type: "tool", name: "read", state: "error", input })])
        ).toStrictEqual([{ kind: "action", verb: "read", target: "b.go" }]);
    });
    it("takes a file tool's target from file_path, then pattern, else the raw input", () => {
        const tool = (name: string, input: unknown) =>
            JSON.stringify({ type: "tool", name, state: "completed", input });
        const entries = projectOpencodeTranscript([
            tool("read", JSON.stringify({ file_path: "C:\\x\\y.ts" })),
            tool("grep", JSON.stringify({ pattern: "TODO" })),
            tool("read", JSON.stringify({ filePath: "", pattern: "*.go" })),
            tool("read", JSON.stringify({ filePath: 7, pattern: "*.ts" })),
            tool("glob", "not json"),
            tool("glob", JSON.stringify({ other: 1 })),
        ]);
        expect(entries.map((e) => (e as { target: string }).target)).toEqual([
            "y.ts",
            "TODO",
            "*.go",
            "*.ts",
            "not json",
            '{"other":1}',
        ]);
    });
});

describe("extractOpencodeTitle", () => {
    it("prefers the session record title", () => {
        expect(extractOpencodeTitle(SHADOW)).toBe("Fix the flaky test");
    });
    it("falls back to the first user text", () => {
        expect(extractOpencodeTitle([`{"type":"user","text":"do the thing","ts":1}`])).toBe("do the thing");
    });
    it("reads a title only from a session record, and later records do not clear it", () => {
        expect(
            extractOpencodeTitle([
                `{"type":"session","title":"Real title"}`,
                `{"type":"state","state":"working"}`,
                `{"type":"user","title":"Not a title","text":"hi"}`,
            ])
        ).toBe("Real title");
        expect(extractOpencodeTitle([`{"type":"user","title":"Not a title","text":"first words"}`])).toBe(
            "first words"
        );
    });
    it("skips a session record with a blank, missing or non-string title", () => {
        for (const session of [
            `{"type":"session","title":"  "}`,
            `{"type":"session"}`,
            `{"type":"session","title":5}`,
        ]) {
            expect(extractOpencodeTitle([session, `{"type":"user","text":"hello"}`])).toBe("hello");
        }
    });
    it("falls back to the first user record with text, passing over other records", () => {
        expect(
            extractOpencodeTitle([
                `{"type":"state","state":"working"}`,
                `{"type":"assistant","text":"answer"}`,
                `{"type":"user"}`,
                `{"type":"user","text":5}`,
                `{"type":"user","text":"   "}`,
                `{"type":"user","text":"question"}`,
                `{"type":"user","text":"later question"}`,
            ])
        ).toBe("question");
    });
    it("returns undefined for empty input", () => {
        expect(extractOpencodeTitle([])).toBeUndefined();
    });
});
