import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    canRender,
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
