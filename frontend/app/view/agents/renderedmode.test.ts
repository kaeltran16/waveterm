import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    boxButton,
    canRender,
    composerBox,
    contextRing,
    effectiveViewMode,
    isPickerCommand,
    pickerFlipAtom,
    shouldUnflip,
    toggleViewMode,
    viewModeAtom,
} from "./renderedmode";

const agent = (over: Partial<AgentVM> = {}): AgentVM => ({
    id: "tab-1",
    name: "loom",
    task: "",
    state: "idle",
    agent: "claude",
    blockId: "b-1",
    ...over,
});

const LIVE = { ended: false, stage: false };

describe("canRender", () => {
    it("is true for a claude agent with a live block", () => {
        expect(canRender(agent(), LIVE)).toBe(true);
    });
    it("is false for the runtimes the rendered view does not drive", () => {
        for (const rt of ["pi", "codex", "opencode"]) {
            expect(canRender(agent({ agent: rt }), LIVE)).toBe(false);
        }
    });
    it("is false for a plain terminal and for an agent with no block", () => {
        expect(canRender(agent({ kind: "terminal" }), LIVE)).toBe(false);
        expect(canRender(agent({ blockId: undefined }), LIVE)).toBe(false);
    });
    it("is false for an ended worker and a final-stage row", () => {
        expect(canRender(agent(), { ended: true, stage: false })).toBe(false);
        expect(canRender(agent(), { ended: false, stage: true })).toBe(false);
    });
});

describe("isPickerCommand", () => {
    it("is true for a picker command and a bare /model", () => {
        expect(isPickerCommand("/config")).toBe(true);
        expect(isPickerCommand("/model")).toBe(true);
        expect(isPickerCommand("  /config")).toBe(true);
        expect(isPickerCommand("  /model  ")).toBe(true);
    });
    it("is false for /model with an alias, other commands and plain text", () => {
        expect(isPickerCommand("/model opus")).toBe(false);
        expect(isPickerCommand("/compact")).toBe(false);
        expect(isPickerCommand("/review x")).toBe(false);
        expect(isPickerCommand("fix the config")).toBe(false);
        expect(isPickerCommand("/configure")).toBe(false);
    });
});

describe("effectiveViewMode", () => {
    it("is terminal while a picker flip is set", () => {
        expect(effectiveViewMode("rendered", 5)).toBe("terminal");
    });
    it("is the chosen mode with no flip", () => {
        expect(effectiveViewMode("rendered", null)).toBe("rendered");
        expect(effectiveViewMode("terminal", null)).toBe("terminal");
    });
});

describe("shouldUnflip", () => {
    it("unflips on a prompt-boundary hook after the flip only", () => {
        expect(shouldUnflip(100, { hook: "Stop", ts: 99 })).toBe(false);
        expect(shouldUnflip(100, { hook: "Stop", ts: 101 })).toBe(true);
        expect(shouldUnflip(100, { hook: "UserPromptSubmit", ts: 101 })).toBe(true);
        expect(shouldUnflip(100, { hook: "SessionStart", ts: 101 })).toBe(true);
    });
    it("stays flipped on hooks that fire while a picker is open", () => {
        expect(shouldUnflip(100, { hook: "Notification", ts: 101 })).toBe(false);
        expect(shouldUnflip(100, { hook: "PostToolUse", ts: 101 })).toBe(false);
    });
    it("is false with no flip or no hook yet", () => {
        expect(shouldUnflip(null, { hook: "Stop", ts: 101 })).toBe(false);
        expect(shouldUnflip(100, null)).toBe(false);
    });
});

const ASK = {
    questions: [{ header: "Scope", question: "Which scope?", multiSelect: false, options: [{ label: "a" }] }],
} as AgentVM["ask"];

describe("composerBox", () => {
    it("is idle for an agent with a transcript, new for one without, and offers Send", () => {
        const idle = composerBox(agent(), true);
        expect(idle).toMatchObject({ kind: "idle", askBlocks: false, live: false });
        expect(idle.placeholder).toContain("loom");
        const fresh = composerBox(agent(), false);
        expect(fresh.kind).toBe("new");
        expect(fresh.placeholder).toContain("loom");
        expect(fresh.placeholder).not.toBe(idle.placeholder);
        expect(boxButton(idle, false)).toBe("send");
        expect(boxButton(idle, true)).toBe("send");
    });
    it("while working, an empty box offers Stop and a filled one Send (steer)", () => {
        const box = composerBox(agent({ state: "working" }), true);
        expect(box).toMatchObject({ kind: "working", askBlocks: false, live: true });
        expect(box.placeholder).not.toBe(composerBox(agent(), true).placeholder);
        expect(boxButton(box, false)).toBe("stop");
        expect(boxButton(box, true)).toBe("send");
    });
    it("while an answerable ask is shown, Send is blocked and the empty box offers Stop", () => {
        const box = composerBox(agent({ state: "asking", ask: ASK }), true);
        expect(box).toMatchObject({ askBlocks: true, live: true });
        expect(boxButton(box, false)).toBe("stop");
        expect(boxButton(box, true)).toBe("send");
    });
    it("an asking state with no answerable question does not block Send", () => {
        expect(composerBox(agent({ state: "asking" }), true).askBlocks).toBe(false);
    });
});

describe("contextRing", () => {
    it("is absent with no reported context", () => {
        expect(contextRing(undefined)).toBeNull();
        expect(contextRing({})).toBeNull();
    });
    it("rounds the percent, clamps the arc and titles with tokens only when the window size is known", () => {
        const known = contextRing({ contextpct: 6.4, contextmax: 1_000_000 });
        expect(known?.pct).toBe(6);
        expect(known?.title).toContain("6");
        expect(known?.title).toContain("1M");
        const unknown = contextRing({ contextpct: 140 });
        expect(unknown?.pct).toBe(140);
        expect(unknown?.arc).toBe(1);
        expect(unknown?.title).not.toContain("tokens");
    });
});

describe("toggleViewMode", () => {
    it("flips the mode, and a flipped agent goes back to rendered with the flip cleared", () => {
        const id = "toggle-agent";
        expect(globalStore.get(viewModeAtom(id))).toBe("terminal");
        toggleViewMode(id);
        expect(globalStore.get(viewModeAtom(id))).toBe("rendered");
        globalStore.set(pickerFlipAtom(id), 50);
        toggleViewMode(id);
        expect(globalStore.get(pickerFlipAtom(id))).toBeNull();
        expect(globalStore.get(viewModeAtom(id))).toBe("rendered");
        toggleViewMode(id);
        expect(globalStore.get(viewModeAtom(id))).toBe("terminal");
    });
});
