// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    agentRowMenuItems,
    askScrollTop,
    clampQuestionIndex,
    entriesToShow,
    isFinishTransition,
    muteMode,
    muteTitle,
    subagentsLabel,
    tasksLabel,
} from "./agentrowmodel";

describe("entriesToShow", () => {
    it("prefers live entries when present", () => {
        expect(entriesToShow([1, 2], [9])).toEqual([1, 2]);
    });
    it("falls back to previousInfo when live is empty", () => {
        expect(entriesToShow([], [9])).toEqual([9]);
    });
    it("falls back to [] when live is empty and previousInfo is absent", () => {
        expect(entriesToShow([], undefined)).toEqual([]);
    });
});

describe("clampQuestionIndex", () => {
    it("defaults an absent index to 0", () => {
        expect(clampQuestionIndex(undefined, 3)).toBe(0);
    });
    it("clamps to the last question", () => {
        expect(clampQuestionIndex(5, 3)).toBe(2);
    });
    it("stays at 0 when there are no questions", () => {
        expect(clampQuestionIndex(2, 0)).toBe(0);
    });
    it("keeps an in-range index", () => {
        expect(clampQuestionIndex(1, 3)).toBe(1);
    });
});

describe("muteMode", () => {
    it("dismisses an idle agent and backgrounds an active one", () => {
        expect(muteMode("idle")).toBe("dismiss");
        expect(muteMode("working")).toBe("background");
        expect(muteMode("asking")).toBe("background");
    });
});

describe("isFinishTransition", () => {
    it("is true only on working -> idle", () => {
        expect(isFinishTransition("working", "idle")).toBe(true);
        expect(isFinishTransition("asking", "idle")).toBe(false);
        expect(isFinishTransition("working", "asking")).toBe(false);
        expect(isFinishTransition("idle", "idle")).toBe(false);
    });

    it("waits out standing by: finishes when the last shell task ends, not at the Stop", () => {
        expect(isFinishTransition("working", "idle", false, false)).toBe(true);
        expect(isFinishTransition("working", "idle", false, true)).toBe(false);
        expect(isFinishTransition("idle", "idle", true, false)).toBe(true);
        expect(isFinishTransition("idle", "idle", false, false)).toBe(false);
        expect(isFinishTransition("idle", "idle", true, true)).toBe(false);
    });
});

describe("agentRowMenuItems", () => {
    it("always includes open, terminal, copy, a separator, and a danger close", () => {
        const items = agentRowMenuItems({ hasDiff: false, mute: null });
        expect(items).toEqual([
            { key: "open", label: "Open" },
            { key: "terminal", label: "Open terminal" },
            { key: "copy", label: "Copy name" },
            { separator: true },
            { key: "close", label: "Close agent", danger: true },
        ]);
    });
    it("adds Review changes when there is a diff", () => {
        const items = agentRowMenuItems({ hasDiff: true, mute: null });
        expect(items.some((i) => "key" in i && i.key === "diff" && i.label === "Review changes")).toBe(true);
    });
    it("labels the mute item by what it does: background an active card, move an idle one to Idle", () => {
        const muteLabel = (mute: "background" | "dismiss") =>
            agentRowMenuItems({ hasDiff: false, mute }).find((i) => "key" in i && i.key === "mute");
        expect(muteLabel("background")).toEqual({ key: "mute", label: "Move to background" });
        expect(muteLabel("dismiss")).toEqual({ key: "mute", label: "Move to Idle" });
    });
    it("orders optional items diff -> mute between terminal and copy", () => {
        const items = agentRowMenuItems({ hasDiff: true, mute: "dismiss" });
        const keys = items.map((i) => ("key" in i ? i.key : "sep"));
        expect(keys).toEqual(["open", "terminal", "diff", "mute", "copy", "sep", "close"]);
    });
});

describe("muteTitle", () => {
    it("names the button's action, with the B key only where it backgrounds", () => {
        expect(muteTitle("background")).toBe("Move to background (B)");
        expect(muteTitle("dismiss")).toBe("Move to Idle");
    });
});

describe("askScrollTop", () => {
    it("holds the answer band's top in view when the bottom pin would scroll past it", () => {
        expect(askScrollTop(120, 300)).toBe(120);
    });
    it("leaves the bottom pin alone when it already shows the band's top", () => {
        expect(askScrollTop(300, 120)).toBeNull();
        expect(askScrollTop(120, 120)).toBeNull();
    });
});

describe("chip labels", () => {
    it("names what it counts", () => {
        expect(subagentsLabel(3)).toBe("3 subagents");
        expect(subagentsLabel(1)).toBe("1 subagent");
        expect(tasksLabel(3, 5)).toBe("3/5 tasks");
    });
});
