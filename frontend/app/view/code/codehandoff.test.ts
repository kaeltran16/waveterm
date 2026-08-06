// frontend/app/view/code/codehandoff.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { handoffLine, liveAgentsForProject } from "./codehandoff";

const agent = (over: Partial<AgentVM>): AgentVM =>
    ({ id: "t1", name: "a", task: "", state: "working", ...over }) as AgentVM;

describe("handoffLine", () => {
    it("references the file when there is no selection", () => {
        expect(handoffLine({ rel: "src/a.ts" })).toBe("look at src/a.ts");
    });

    it("references a single line", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 12, endLine: 12 })).toBe("look at src/a.ts:12");
    });

    it("references a line range", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 12, endLine: 40 })).toBe("look at src/a.ts:12-40");
    });

    it("appends a note", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 3, endLine: 3, note: "this leaks" })).toBe(
            "look at src/a.ts:3 — this leaks"
        );
    });

    it("is always ONE line, because the payload is injected into a PTY and submitted on the first newline", () => {
        const out = handoffLine({ rel: "src/a.ts", note: "first\nsecond\n\tthird" });
        expect(out).toBe("look at src/a.ts — first second third");
        expect(out.includes("\n")).toBe(false);
    });

    it("ignores a whitespace-only note", () => {
        expect(handoffLine({ rel: "src/a.ts", note: "   \n  " })).toBe("look at src/a.ts");
    });
});

describe("liveAgentsForProject", () => {
    const roster: AgentVM[] = [
        agent({ id: "match", project: "waveterm", blockId: "b1" }),
        agent({ id: "other-project", project: "elsewhere", blockId: "b2" }),
        agent({ id: "no-block", project: "waveterm" }),
        agent({ id: "terminal", project: "waveterm", blockId: "b3", kind: "terminal" }),
        agent({ id: "background", project: "waveterm", blockId: "b4", kind: "background" }),
        agent({ id: "explicit-agent", project: "waveterm", blockId: "b5", kind: "agent" }),
    ];

    it("keeps agents in this project that have a terminal block to write to", () => {
        expect(liveAgentsForProject(roster, "waveterm").map((a) => a.id)).toEqual(["match", "explicit-agent"]);
    });

    it("returns nothing for an unknown project", () => {
        expect(liveAgentsForProject(roster, "nope")).toEqual([]);
    });

    it("returns nothing for a blank project name, so a worktree cannot match everything", () => {
        expect(liveAgentsForProject(roster, "")).toEqual([]);
    });
});
