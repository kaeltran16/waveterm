// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractClaudeEvents, extractCodexEvents, extractEvents } from "./activityevents";

const base = { agent: "claude", sessionPath: "/p/s.jsonl", agentName: "sess", project: "waveterm", live: false } as const;
const L = (o: object): string => JSON.stringify(o);

const lines = [
    L({ type: "user", timestamp: "2026-06-20T10:00:00.000Z", message: { content: "fix the bug" } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:05.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'git commit -m "fix race"' } }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:08.000Z", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } }),
    L({ type: "user", timestamp: "2026-06-20T10:00:09.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:12.000Z", message: { content: [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { questions: [{ question: "Which approach?" }] } }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:20.000Z", message: { content: [{ type: "text", text: "All done." }] } }),
];

describe("extractClaudeEvents", () => {
    it("extracts the five event types, in ts order, with text and project", () => {
        const evs = extractClaudeEvents(lines, base);
        expect(evs.map((e) => e.type)).toEqual(["started", "committed", "errored", "asked", "finished"]);
        expect(evs[0].text).toBe("fix the bug");
        expect(evs[1].text).toBe("fix race");
        expect(evs[2].text).toContain("npm test");
        expect(evs[3].text).toBe("Which approach?");
        expect(evs.every((e) => e.project === "waveterm")).toBe(true);
    });
    it("omits finished and stamps live/liveId when the session is live", () => {
        const evs = extractClaudeEvents(lines, { ...base, live: true, liveId: "tab1" });
        expect(evs.some((e) => e.type === "finished")).toBe(false);
        expect(evs.every((e) => e.live && e.liveId === "tab1")).toBe(true);
    });
    it("does not treat a non-commit Bash as committed", () => {
        const only = [L({ type: "assistant", timestamp: "2026-06-20T10:00:00.000Z", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "git status" } }] } })];
        expect(extractClaudeEvents(only, base).some((e) => e.type === "committed")).toBe(false);
    });
});

const cbase = { agent: "codex", sessionPath: "/c/r.jsonl", agentName: "codex", project: "", live: false } as const;

describe("extractCodexEvents", () => {
    const clines = [
        L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "C:\\Users\\me\\IdeaProjects\\krypton", thread_source: "parent" } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:03.000Z", payload: { type: "function_call", call_id: "c1", name: "shell_command", arguments: '{"command":"git commit -m \\"add index\\""}' } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:05.000Z", payload: { type: "function_call", call_id: "c2", name: "shell_command", arguments: '{"command":"go test ./..."}' } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:07.000Z", payload: { type: "function_call_output", call_id: "c2", output: "Exit code: 1\nFAIL" } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:10.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] } }),
    ];
    it("extracts project from session_meta cwd and the codex event types", () => {
        const evs = extractCodexEvents(clines, cbase);
        expect(evs.map((e) => e.type)).toEqual(["started", "committed", "errored", "finished"]);
        expect(evs.every((e) => e.project === "krypton")).toBe(true);
        expect(evs[1].text).toBe("add index");
        expect(evs[2].text).toContain("go test");
    });
    it("excludes subagent rollouts entirely", () => {
        const sub = [L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "/x/y", thread_source: "subagent" } }), ...clines.slice(1)];
        expect(extractCodexEvents(sub, cbase)).toEqual([]);
    });
});

describe("extractEvents dispatcher", () => {
    it("routes codex to the codex extractor", () => {
        const evs = extractEvents([L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "/a/b/opal" } })], cbase);
        expect(evs[0]?.type).toBe("started");
        expect(evs[0]?.project).toBe("opal");
    });
});
