import { describe, expect, it } from "vitest";
import { globalStore } from "@/app/store/global";
import {
    beginSave,
    failSave,
    harnessPreferenceAtom,
    initHarnessPreference,
    persistSave,
    resolveDefaultRuntime,
    type HarnessPreferenceState,
} from "./harnessstore";

const idle = (runtime: string, tier = "capable"): HarnessPreferenceState => ({
    runtime,
    persistedRuntime: runtime,
    tier,
    persistedTier: tier,
    saving: false,
});

describe("harness preference transitions", () => {
    it("updates the selection immediately and marks the write in flight", () => {
        expect(beginSave({ runtime: "codex", persistedRuntime: "codex", tier: "capable", persistedTier: "capable", saving: false }, "opencode", "mid")).toEqual({
            runtime: "opencode",
            persistedRuntime: "codex",
            tier: "mid",
            persistedTier: "capable",
            saving: true,
        });
    });

    it("persists the selection on success", () => {
        const begin = beginSave(idle("codex"), "opencode", "mid");
        expect(persistSave(begin)).toEqual({
            runtime: "opencode",
            persistedRuntime: "opencode",
            tier: "mid",
            persistedTier: "mid",
            saving: false,
            error: undefined,
        });
    });

    it("rolls back to the persisted value and surfaces the error on failure", () => {
        const begin = beginSave(idle("codex", "cheap"), "opencode", "mid");
        expect(failSave(begin, "denied")).toMatchObject({
            runtime: "codex",
            persistedRuntime: "codex",
            tier: "cheap",
            persistedTier: "cheap",
            saving: false,
            error: "denied",
        });
    });

    it("has no dispatchable value while saving", () => {
        const begin = beginSave(idle("codex"), "opencode", "mid");
        expect(begin.saving).toBe(true);
    });

    it("preserves a non-empty loaded tier", () => {
        initHarnessPreference("pi", "cheap");
        expect(globalStore.get(harnessPreferenceAtom)).toMatchObject({
            runtime: "pi",
            persistedRuntime: "pi",
            tier: "cheap",
            persistedTier: "cheap",
            saving: false,
        });
    });

    it("normalizes an empty loaded tier to capable", () => {
        initHarnessPreference("codex", "");
        expect(globalStore.get(harnessPreferenceAtom)).toMatchObject({
            runtime: "codex",
            persistedRuntime: "codex",
            tier: "capable",
            persistedTier: "capable",
            saving: false,
        });
    });
});

const h = (runtime: string, installed = true, runworkercapable = true): HarnessInfo =>
    ({ runtime, label: runtime, installed, consultcapable: true, runworkercapable }) as HarnessInfo;

describe("resolveDefaultRuntime", () => {
    // catalog order (harness.List() -> ListHarnessesCommand) — pi first
    const harnesses = [h("pi"), h("claude"), h("codex"), h("opencode")];

    it("prefers an explicit installed preference", () => {
        expect(resolveDefaultRuntime("codex", harnesses)).toBe("codex");
    });

    it("falls back to pi when no preference exists", () => {
        expect(resolveDefaultRuntime("", harnesses)).toBe("pi");
    });

    it("ignores a preference whose harness is not installed", () => {
        expect(resolveDefaultRuntime("pi", [h("claude"), h("codex")])).toBe("claude");
    });

    it("returns the first installed harness when pi is absent", () => {
        expect(resolveDefaultRuntime("", [h("claude"), h("codex")])).toBe("claude");
    });

    it("returns empty when nothing is installed", () => {
        expect(resolveDefaultRuntime("", [h("pi", false)])).toBe("");
    });
});
