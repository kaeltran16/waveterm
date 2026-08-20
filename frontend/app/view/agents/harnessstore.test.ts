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
    route: { runtime, tier },
    persistedRoute: { runtime, tier },
    saving: false,
});

describe("harness preference transitions", () => {
    it("updates the selection immediately and marks the write in flight", () => {
        expect(beginSave(idle("codex"), "opencode", "mid")).toEqual({
            route: { runtime: "opencode", tier: "mid" },
            persistedRoute: { runtime: "codex", tier: "capable" },
            saving: true,
        });
    });

    it("persists the selection on success", () => {
        const begin = beginSave(idle("codex"), "opencode", "mid");
        expect(persistSave(begin)).toEqual({
            route: { runtime: "opencode", tier: "mid" },
            persistedRoute: { runtime: "opencode", tier: "mid" },
            saving: false,
            error: undefined,
        });
    });

    it("rolls back to the persisted value and surfaces the error on failure", () => {
        const begin = beginSave(idle("codex", "cheap"), "opencode", "mid");
        expect(failSave(begin, "denied")).toMatchObject({
            route: { runtime: "codex", tier: "cheap" },
            persistedRoute: { runtime: "codex", tier: "cheap" },
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
            route: { runtime: "pi", tier: "cheap" },
            persistedRoute: { runtime: "pi", tier: "cheap" },
            saving: false,
        });
    });

    it("normalizes an empty loaded tier to capable", () => {
        initHarnessPreference("codex", "");
        expect(globalStore.get(harnessPreferenceAtom)).toMatchObject({
            route: { runtime: "codex", tier: "capable" },
            persistedRoute: { runtime: "codex", tier: "capable" },
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
