import { describe, expect, it } from "vitest";
import { readProactiveSuggestion } from "./proactive";

function run(meta: Record<string, unknown>): Run {
    return { oid: "run-1", meta } as unknown as Run;
}

describe("readProactiveSuggestion", () => {
    it("returns a view-model for a hit", () => {
        const vm = readProactiveSuggestion(
            run({
                "jarvis:proactive": {
                    status: "hit",
                    nodeId: "dec-1",
                    sourceType: "decision",
                    title: "Rate limiting",
                    snippet: "drop-oldest on overflow",
                    why: 'Related to "fix rate limit"',
                },
            })
        );
        expect(vm).not.toBeNull();
        expect(vm?.title).toBe("Rate limiting");
        expect(vm?.sourceType).toBe("decision");
    });

    it("returns null for the none sentinel", () => {
        expect(readProactiveSuggestion(run({ "jarvis:proactive": { status: "none" } }))).toBeNull();
    });

    it("returns null when there is no proactive meta", () => {
        expect(readProactiveSuggestion(run({}))).toBeNull();
    });

    it("returns null when dismissed via the meta flag", () => {
        expect(
            readProactiveSuggestion(
                run({
                    "jarvis:proactive": {
                        status: "hit",
                        nodeId: "d",
                        sourceType: "decision",
                        title: "x",
                        snippet: "y",
                        why: "z",
                    },
                    "jarvis:proactive:dismissed": true,
                })
            )
        ).toBeNull();
    });
});
