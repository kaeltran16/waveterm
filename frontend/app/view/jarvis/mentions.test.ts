import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { mentionedDossierIds } from "./mentions";

function card(n: number, sourceType: GroundingCard["sourceType"], navTarget: string): GroundingCard {
    return { n, sourceType, title: "t" + n, project: "p", ageMs: 0, freshness: "fresh", navTarget };
}

function convo(cards: GroundingCard[][]): JarvisConversation {
    return {
        id: "c1",
        title: "why",
        scope: { mode: "all", chips: [], attached: [] },
        turns: cards.map((grounding) => ({
            role: "jarvis" as const,
            workingSteps: [],
            segments: [{ text: "answer" }],
            grounding,
            terminal: "answered" as const,
        })),
    };
}

describe("mentionedDossierIds", () => {
    it("returns the dossier ids cited across every turn, in first-cited order", () => {
        const c = convo([
            [card(1, "run", "run:r1"), card(2, "task", "task-418")],
            [card(1, "task", "task-402")],
        ]);
        expect(mentionedDossierIds(c)).toEqual(["task-418", "task-402"]);
    });

    it("ignores non-task sources — a run or memory citation is not attribution", () => {
        const c = convo([[card(1, "run", "run:r1"), card(2, "memory", "memory:m1"), card(3, "decision", "dec:d1")]]);
        expect(mentionedDossierIds(c)).toEqual([]);
    });

    it("dedups a dossier cited in several turns", () => {
        const c = convo([[card(1, "task", "task-418")], [card(1, "task", "task-418")]]);
        expect(mentionedDossierIds(c)).toEqual(["task-418"]);
    });

    it("accepts an oref-shaped task target and keeps only the oid half", () => {
        const c = convo([[card(1, "task", "task:task-418")]]);
        expect(mentionedDossierIds(c)).toEqual(["task-418"]);
    });

    it("ignores a task card whose target points at another otype rather than inventing an id from it", () => {
        const c = convo([[card(1, "task", "run:r1")]]);
        expect(mentionedDossierIds(c)).toEqual([]);
    });

    it("skips a task card with an empty target rather than yielding an empty id", () => {
        const c = convo([[card(1, "task", "")]]);
        expect(mentionedDossierIds(c)).toEqual([]);
    });

    it("returns nothing for a conversation with no turns", () => {
        expect(mentionedDossierIds(convo([]))).toEqual([]);
    });
});
