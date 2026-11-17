// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BrainstormFile, BuilderCheckView, BuilderQuestion } from "./brainstormmodel";
import { builderHead, cardClock, cardTime, checkCardState, clockBar, settledLine } from "./renderedbscheckmodel";

const READING: BuilderCheckView = { kind: "pending", stage: "reading", text: "A builder is reading the design." };
const TAKING_IN: BuilderCheckView = {
    kind: "pending",
    stage: "taking-in",
    text: "Taking in the builder's questions.",
};
const FAILED: BuilderCheckView = { kind: "failed", reason: "The agent ended its turn without starting it." };
const NONE: BuilderCheckView = { kind: "none" };

const OPEN: BuilderQuestion = {
    q: "Does time spent queued count toward the run's wall time in Usage?",
    part: "queue",
    options: [
        { label: "Yes", detail: "wall time is what you waited" },
        { label: "No, show the wait apart", detail: "a queued line beside wall time" },
    ],
};
const ANSWERED: BuilderQuestion = { q: "Which runs?", part: "what", a: "Every run" };

function file(yours: BuilderQuestion[], over: Partial<BrainstormFile> = {}): BrainstormFile {
    return {
        v: 1,
        title: "Run memory pressure",
        spec: "docs/specs/mem.md",
        question: null,
        working: null,
        parts: [
            { id: "queue", title: "Final queue", state: "yours", body: "" },
            { id: "what", title: "What counts", state: "yours", body: "" },
        ],
        history: [],
        done: true,
        check: { yours, calls: [{ text: "Reuse the median." }], answered: ["The profile."] },
        run: null,
        ...over,
    };
}

describe("checkCardState", () => {
    it.each([
        ["a builder reading", file([]), READING, "reading"],
        ["the agent taking in its questions", file([]), TAKING_IN, "taking-in"],
        ["a check that did not finish", file([]), FAILED, "failed"],
        ["a builder question open", file([ANSWERED, OPEN]), NONE, "asking"],
        ["every builder question answered", file([ANSWERED]), NONE, "settled"],
        ["a check with nothing for the user", file([]), NONE, "settled"],
    ] as const)("%s", (_what, f, check, want) => {
        expect(checkCardState(f, check, false)).toBe(want);
    });

    it("a pending check outranks a builder question left open by an earlier check", () => {
        expect(checkCardState(file([OPEN]), READING, false)).toBe("reading");
    });
});

describe("builderHead", () => {
    it("counts the open question among the builder's and names the part it is for", () => {
        expect(builderHead(file([ANSWERED, OPEN]))).toEqual({
            lead: "Builder question · 2 of 2",
            part: { id: "queue", title: "Final queue" },
        });
    });

    it("has no part to link when the question names none", () => {
        const f = file([{ q: "Anything else?" }]);
        expect(builderHead(f)).toEqual({ lead: "Builder question · 1 of 1", part: null });
    });
});

describe("settledLine", () => {
    it("says how many questions are settled and what approving does", () => {
        expect(settledLine(3)).toBe("Its 3 questions are settled. Approving starts an orchestrator run from the spec.");
    });

    it("agrees with a single question", () => {
        expect(settledLine(1)).toBe("Its 1 question is settled. Approving starts an orchestrator run from the spec.");
    });
});

describe("clockBar", () => {
    it("is null with no bar to draw", () => {
        expect(clockBar(null, false)).toBeNull();
    });

    it("fills and marks the usual time as percentages of the longest, in the accent while within it", () => {
        expect(clockBar({ fill: 0.42, usual: 0.81 }, false)).toEqual({ fill: "42.0%", usual: "81.0%", over: false });
    });

    it("flags a reading check past the usual time", () => {
        expect(clockBar({ fill: 1, usual: 0.81 }, true)).toEqual({ fill: "100.0%", usual: "81.0%", over: true });
    });
});

describe("cardTime", () => {
    it("reads minutes and padded seconds, and seconds alone under a minute", () => {
        expect(cardTime(302_000)).toBe("5m 02s");
        expect(cardTime(370_999)).toBe("6m 10s");
        expect(cardTime(42_000)).toBe("42s");
        expect(cardTime(-5)).toBe("0s");
    });
});

describe("cardClock", () => {
    const TIMES = { usualms: 302_000, longestms: 370_000 };
    const START = 1_000_000;
    const pending = (v: BuilderCheckView) => v as Extract<BuilderCheckView, { kind: "pending" }>;

    it("reads the builder's time and the past checks' times as the BuilderCheck board does", () => {
        const c = cardClock(pending(READING), { start: START, end: null }, TIMES, START + 130_000);
        expect(c.elapsed).toBe("2m 10s");
        expect(c.times).toBe("usual 5m 02s · longest 6m 10s");
        expect(c.running).toBe(true);
        expect(c.over).toBe(false);
        expect(c.note).toBe("Checks here usually take about 5m. Edits to the design wait until it is back.");
    });

    it("says it is taking longer once past the usual time", () => {
        const c = cardClock(pending(READING), { start: START, end: null }, TIMES, START + 460_000);
        expect(c.over).toBe(true);
        expect(c.note).toBe(
            "Taking longer than usual: most checks here finish in about 5m. Edits to the design wait until it is back."
        );
    });

    it("says how long the builder took while the agent takes its questions in", () => {
        const c = cardClock(pending(TAKING_IN), { start: START, end: START + 302_000 }, TIMES, START + 900_000);
        expect(c.elapsed).toBe("5m 02s");
        expect(c.running).toBe(false);
        expect(c.note.startsWith("The builder finished in 5m 02s.")).toBe(true);
    });

    it("drops the times with no past checks to go by", () => {
        const c = cardClock(pending(READING), { start: START, end: null }, null, START + 10_000);
        expect(c.times).toBeNull();
        expect(c.elapsed).toBe("10s");
        expect(c.note).toBe("Edits to the design wait until it is back.");
    });
});
