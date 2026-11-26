import { describe, expect, it } from "vitest";
import { correlateSubagents } from "./subagentcorrelate";
import { stepTitle } from "./transcriptlayout";
import type { SubagentSpawn } from "./transcriptprojection";

const spawn = (over: Partial<SubagentSpawn>): SubagentSpawn => ({
    toolUseId: "t",
    subagentType: "Explore",
    prompt: "look at X",
    done: false,
    failed: false,
    background: false,
    ...over,
});
const file = (over: Partial<SubagentFileInfo>): SubagentFileInfo => ({
    agentid: "a1",
    transcriptpath: "/p/agent-a1.jsonl",
    firstprompt: "look at X",
    startedatms: 1,
    done: false,
    toolcount: 0,
    ...over,
});

describe("correlateSubagents", () => {
    it("takes type + success state from a matched, completed spawn", () => {
        const out = correlateSubagents([spawn({ done: true })], [file({})]);
        expect(out).toEqual([
            {
                id: "a1",
                type: "Explore",
                state: "success",
                background: false,
                transcriptPath: "/p/agent-a1.jsonl",
                startedAtMs: 1,
                toolCount: 0,
                toolUseId: "t",
            },
        ]);
    });

    it("maps an errored spawn to failure", () => {
        const out = correlateSubagents([spawn({ done: true, failed: true })], [file({})]);
        expect(out[0].state).toBe("failure");
    });

    it("maps a matched running spawn to working", () => {
        expect(correlateSubagents([spawn({ done: false })], [file({})])[0].state).toBe("working");
    });

    it("maps an unmatched, unfinished file to working", () => {
        expect(correlateSubagents([], [file({ firstprompt: "orphan", done: false })])[0].state).toBe("working");
    });

    it("maps an unmatched, terminated file to the neutral done state", () => {
        expect(correlateSubagents([], [file({ firstprompt: "orphan", done: true })])[0].state).toBe("done");
    });

    it("matches on normalized whitespace", () => {
        const out = correlateSubagents(
            [spawn({ prompt: "look   at\nX", done: true })],
            [file({ firstprompt: "look at X" })]
        );
        expect(out[0].type).toBe("Explore");
    });

    it("pairs parallel same-type spawns 1:1 in file order", () => {
        const spawns = [
            spawn({ toolUseId: "a", prompt: "P1", done: true }),
            spawn({ toolUseId: "b", prompt: "P2", done: true, failed: true }),
        ];
        const files = [file({ agentid: "f1", firstprompt: "P1" }), file({ agentid: "f2", firstprompt: "P2" })];
        const out = correlateSubagents(spawns, files);
        expect(out.map((s) => [s.id, s.state])).toEqual([
            ["f1", "success"],
            ["f2", "failure"],
        ]);
    });

    it("background spawn is done when its child file is done", () => {
        const bg = spawn({ background: true, done: false });
        expect(correlateSubagents([bg], [file({ done: false })])[0].state).toBe("working");
        expect(correlateSubagents([{ ...bg }], [file({ done: true })])[0].state).toBe("done");
        expect(correlateSubagents([spawn({ background: true, done: true })], [file({ done: true })])[0].state).toBe(
            "success"
        );
        expect(
            correlateSubagents([spawn({ background: true, done: true, failed: true })], [file({ done: false })])[0]
                .state
        ).toBe("failure");
    });

    it("correlate copies background", () => {
        expect(correlateSubagents([spawn({ background: true })], [file({})])[0].background).toBe(true);
        expect(correlateSubagents([spawn({})], [file({})])[0].background).toBe(false);
        expect(correlateSubagents([], [file({ firstprompt: "orphan" })])[0].background).toBe(false);
    });

    it("falls back to the prompt's first line when no spawn matches", () => {
        const out = correlateSubagents([], [file({ firstprompt: "Investigate the crash\nmore detail" })]);
        expect(out[0].type).toBe("Investigate the crash");
    });

    const labelOf = (firstprompt: string) => correlateSubagents([], [file({ firstprompt })])[0].type;

    it("labels an unmatched file with its first non-blank line, trimmed", () => {
        expect(labelOf("\n   \n  Indented line  \nsecond")).toBe("Indented line");
    });

    it("cuts a fallback label to 40 characters and leaves one of 40 whole", () => {
        expect(labelOf("x".repeat(40))).toBe("x".repeat(40));
        expect(labelOf("x".repeat(41))).toBe("x".repeat(40));
        expect(labelOf("y".repeat(80) + "\nnext")).toBe("y".repeat(40));
    });

    it("labels an unmatched file with a blank prompt as subagent", () => {
        expect(labelOf("  \n ")).toBe("subagent");
    });

    it("joins a file to the spawn its meta names, over a spawn whose prompt matches", () => {
        const named = spawn({
            toolUseId: "tu_audit",
            subagentType: "general-purpose",
            prompt: "Audit the release notes for 2.4",
            background: true,
            done: true,
            failed: true,
        });
        const decoy = spawn({ toolUseId: "tu_other", subagentType: "Explore", prompt: "reworded prompt", done: true });
        const [out] = correlateSubagents([decoy, named], [file({ firstprompt: "reworded prompt", tooluseid: "tu_audit" })]);
        expect([out.type, out.background, out.state, out.toolUseId]).toEqual([
            "general-purpose",
            true,
            "failure",
            "tu_audit",
        ]);
    });

    // file stopped, then the spawn's result or notification, then file finished, then parent ended, else working
    it.each([
        [
            "a stopped file over a successful notification",
            spawn({ background: true, done: true }),
            file({ stopped: true }),
            false,
            "stopped",
        ],
        ["a finished file with no result yet", spawn({ done: false }), file({ done: true }), false, "done"],
        ["an unfinished file once the parent ended", spawn({ done: false }), file({ done: false }), true, "stopped"],
    ] as const)("resolves %s", (_name, s, f, parentEnded, want) => {
        expect(correlateSubagents([s], [f], { parentEnded })[0].state).toBe(want);
    });

    it("copies the file's facts, its description falling back to the spawn's", () => {
        const [withMeta, noMeta] = correlateSubagents(
            [spawn({ toolUseId: "tu_b", prompt: "P2", description: "from the call" })],
            [
                file({
                    agentid: "f1",
                    firstprompt: "P1",
                    tooluseid: "tu_a",
                    description: "from the meta",
                    agenttype: "Plan",
                    startedatms: 100,
                    endedatms: 900,
                    done: true,
                    toolcount: 14,
                }),
                file({ agentid: "f2", firstprompt: "P2" }),
            ]
        );
        expect(withMeta).toMatchObject({
            type: "Plan",
            toolUseId: "tu_a",
            description: "from the meta",
            startedAtMs: 100,
            endedAtMs: 900,
            toolCount: 14,
        });
        expect([noMeta.toolUseId, noMeta.description]).toEqual(["tu_b", "from the call"]);
    });

    it("names the running call as a step row names it, and drops it once the subagent is not working", () => {
        const running = file({ currentcall: { name: "Grep", input: { pattern: "parsePlan(", path: "pkg/" }, startedatms: 5 } });
        const [out] = correlateSubagents([], [running]);
        expect(stepTitle(out.currentCall!)).toEqual({ title: "Searched", mono: "parsePlan(" });
        expect([out.currentCall!.pending, out.currentCall!.startedTs]).toEqual([true, 5]);
        expect(correlateSubagents([], [running], { parentEnded: true })[0].currentCall).toBeUndefined();
    });
});
