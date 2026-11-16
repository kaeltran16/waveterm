// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";
import type { TranscriptContext } from "./transcriptcontext";

const user = (text: string): AgentEntry => ({ kind: "user", text });
const lead: TranscriptContext = { role: { kind: "lead", runId: "r-1" } };
const worker: TranscriptContext = { role: { kind: "worker", leadRunId: "r-1", taskId: "t-2" } };

describe("arcMessageOf", () => {
    it("classifies a wake by its prefix, after trimming", () => {
        expect(arcMessageOf(user("  wake: run finished. wsh jarvis dag status\n"), false, lead)).toEqual({
            kind: "wake",
            text: "wake: run finished. wsh jarvis dag status",
        });
    });

    it("classifies a brainstorm line by its prefix", () => {
        expect(arcMessageOf(user("brainstorm: judged C:/b/brainstorm.json"), false)?.kind).toBe("brainstorm");
    });

    it("a wake that is a run agent's first entry is still a wake", () => {
        expect(arcMessageOf(user("wake: x"), true, lead)?.kind).toBe("wake");
    });

    it("the first user entry of a run's agent is its brief, with the role's kind", () => {
        expect(arcMessageOf(user("Build t-2"), true, worker)).toEqual({
            kind: "brief",
            role: "worker",
            text: "Build t-2",
        });
        expect(arcMessageOf(user("Lead the run"), true, lead)).toMatchObject({ kind: "brief", role: "lead" });
    });

    it("a later user entry with a role is not a brief", () => {
        expect(arcMessageOf(user("keep going"), false, lead)).toBeNull();
    });

    it("the first user entry without a role is not a brief", () => {
        expect(arcMessageOf(user("hello"), true, {})).toBeNull();
        expect(arcMessageOf(user("hello"), true)).toBeNull();
    });

    it("only user entries are Arc messages", () => {
        expect(arcMessageOf({ kind: "message", text: "wake: x" }, true, lead)).toBeNull();
    });
});
