import { describe, expect, it } from "vitest";
import type { AgentAskQuestion, AgentVM } from "./agentsviewmodel";
import { canDismissAsk, enterAction, pickAdvance } from "./askflow";

const single = (question: string): AgentAskQuestion => ({
    question,
    options: [{ label: "a" }, { label: "b" }],
});
const multi = (question: string): AgentAskQuestion => ({ ...single(question), multiSelect: true });

describe("pickAdvance", () => {
    it("pickAdvance moves to the next unanswered question", () => {
        const qs = [single("q1"), single("q2"), single("q3")];
        expect(pickAdvance(qs, { 0: new Set([0]) }, {}, 0)).toBe(1);
        // a typed answer counts as answered, so the pick skips past it
        expect(pickAdvance(qs, { 0: new Set([1]) }, { 1: "mine" }, 0)).toBe(2);
    });

    it("pickAdvance stays on multi-select", () => {
        const qs = [multi("q1"), single("q2")];
        expect(pickAdvance(qs, { 0: new Set([0]) }, {}, 0)).toBeNull();
    });

    it("pickAdvance stays when nothing else is unanswered", () => {
        const qs = [single("q1"), single("q2")];
        expect(pickAdvance(qs, { 0: new Set([0]), 1: new Set([1]) }, {}, 1)).toBeNull();
        expect(pickAdvance([single("only")], { 0: new Set([0]) }, {}, 0)).toBeNull();
    });
});

describe("enterAction", () => {
    it("enterAction submits when every question is answered", () => {
        const qs = [single("q1"), multi("q2")];
        expect(enterAction(qs, { 0: new Set([0]), 1: new Set([0, 1]) }, {}, 1)).toEqual({ kind: "submit" });
        expect(enterAction(qs, { 0: new Set([0]) }, { 1: "typed" }, 0)).toEqual({ kind: "submit" });
    });

    it("enterAction moves to the first unanswered question", () => {
        const qs = [single("q1"), single("q2"), single("q3")];
        expect(enterAction(qs, { 0: new Set([0]) }, {}, 0)).toEqual({ kind: "question", qi: 1 });
        // the active question, when unanswered, is where Enter stays
        expect(enterAction(qs, { 0: new Set([0]) }, {}, 2)).toEqual({ kind: "question", qi: 2 });
        // whitespace-only text is not an answer
        expect(enterAction(qs, { 0: new Set([0]), 2: new Set([1]) }, { 1: "  " }, 2)).toEqual({
            kind: "question",
            qi: 1,
        });
    });
});

describe("canDismissAsk", () => {
    const agent = (runtime?: string): AgentVM => ({ id: "t", name: "n", task: "", state: "asking", agent: runtime });

    it("canDismissAsk is true for pi and false for claude, codex and opencode", () => {
        expect(canDismissAsk(agent("pi"))).toBe(true);
        expect(canDismissAsk(agent("claude"))).toBe(false);
        expect(canDismissAsk(agent("codex"))).toBe(false);
        expect(canDismissAsk(agent("opencode"))).toBe(false);
        expect(canDismissAsk(agent(undefined))).toBe(false);
    });
});
