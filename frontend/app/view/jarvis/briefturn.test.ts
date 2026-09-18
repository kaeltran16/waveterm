import { describe, expect, it } from "vitest";
import type { JarvisTurn } from "./jarviscontract";
import { turnProse, turnVerdict } from "./briefturn";

function answer(segments: any[], terminal = "answered"): JarvisTurn {
    return { role: "jarvis", workingSteps: [], segments, grounding: [], terminal } as JarvisTurn;
}

describe("turnProse", () => {
    it("keeps a restored turn's citation markers where the model put them", () => {
        expect(turnProse(answer([{ text: "Fixed in " }, { citationRef: 2 }, { text: "." }]))).toBe("Fixed in [2].");
    });
    it("reads a user turn's text", () => {
        expect(turnProse({ role: "user", text: "what broke?", attachments: [] } as JarvisTurn)).toBe("what broke?");
    });
});

describe("turnVerdict", () => {
    it("badges the verdicts the Brief does not already say", () => {
        expect(turnVerdict("weak")).toEqual({ label: "Weak grounding", tone: "warning" });
        expect(turnVerdict("notfound")).toEqual({ label: "Not found", tone: "muted" });
    });
    it("leaves a failed or cancelled ask to the Brief's own failed-ask note", () => {
        expect(turnVerdict("error")).toBeNull();
        expect(turnVerdict("cancelled")).toBeNull();
    });
    it("gives a normal answer no badge", () => {
        expect(turnVerdict("answered")).toBeNull();
    });
});
