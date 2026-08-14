import { describe, expect, it } from "vitest";
import { proactiveNavOref, readProactiveSuggestion, type ProactiveVM } from "./proactive";

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

function vm(over: Partial<ProactiveVM> = {}): ProactiveVM {
    return { nodeId: "n-1", sourceType: "memory", title: "t", snippet: "s", why: "w", ...over };
}

describe("proactiveNavOref", () => {
    it("maps a dossier hit to task:<nodeId>", () => {
        expect(proactiveNavOref(vm({ sourceType: "dossier" }))).toBe("task:n-1");
    });

    it("maps a memory hit to memnote:<nodeId>", () => {
        expect(proactiveNavOref(vm({ sourceType: "memory" }))).toBe("memnote:n-1");
    });

    it("returns null for a decision hit (no open path)", () => {
        expect(proactiveNavOref(vm({ sourceType: "decision" }))).toBeNull();
    });

    it("returns null for an empty nodeId", () => {
        expect(proactiveNavOref(vm({ nodeId: "" }))).toBeNull();
    });

    it("returns null for an unknown sourceType", () => {
        expect(proactiveNavOref(vm({ sourceType: "weird" }))).toBeNull();
    });

    it("returns null for a null vm", () => {
        expect(proactiveNavOref(null)).toBeNull();
    });
});
