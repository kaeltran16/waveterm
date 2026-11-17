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

    const envelope =
        '[Message from agent "cache_fixer" (tab 3f2a-b1), sent with wsh agents send. Not typed by the user. Its sender reads your reply with wsh agents read, so answer here and do not send one back.]\n';

    it("classifies an enveloped agent message by its sender, tab and body", () => {
        expect(arcMessageOf(user(envelope + "the cache is fixed\nrebase onto main"), false)).toEqual({
            kind: "agent",
            sender: "cache_fixer",
            tabId: "3f2a-b1",
            text: "the cache is fixed\nrebase onto main",
        });
    });

    it("an agent message that is a run agent's first entry is still an agent message", () => {
        expect(arcMessageOf(user(envelope + "hi"), true, worker)?.kind).toBe("agent");
    });

    it("a text that only quotes an envelope is not an agent message", () => {
        expect(
            arcMessageOf(user('he said [Message from agent "x" (tab 1), sent with wsh agents send.]\nhi'), false)
        ).toBeNull();
    });

    it("only user entries are Arc messages", () => {
        expect(arcMessageOf({ kind: "message", text: "wake: x" }, true, lead)).toBeNull();
    });
});
