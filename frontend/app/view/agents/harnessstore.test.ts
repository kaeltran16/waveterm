import { describe, expect, it } from "vitest";
import { beginSave, failSave, persistSave, type HarnessPreferenceState } from "./harnessstore";

const idle = (runtime: string): HarnessPreferenceState => ({
    runtime,
    persistedRuntime: runtime,
    saving: false,
});

describe("harness preference transitions", () => {
    it("updates the selection immediately and marks the write in flight", () => {
        expect(beginSave({ runtime: "codex", persistedRuntime: "codex", saving: false }, "opencode")).toEqual({
            runtime: "opencode",
            persistedRuntime: "codex",
            saving: true,
        });
    });

    it("persists the selection on success", () => {
        const begin = beginSave(idle("codex"), "opencode");
        expect(persistSave(begin)).toEqual({ runtime: "opencode", persistedRuntime: "opencode", saving: false, error: undefined });
    });

    it("rolls back to the persisted value and surfaces the error on failure", () => {
        const begin = beginSave(idle("codex"), "opencode");
        expect(failSave(begin, "denied")).toMatchObject({
            runtime: "codex",
            persistedRuntime: "codex",
            saving: false,
            error: "denied",
        });
    });

    it("has no dispatchable value while saving", () => {
        const begin = beginSave(idle("codex"), "opencode");
        expect(begin.saving).toBe(true);
    });
});
