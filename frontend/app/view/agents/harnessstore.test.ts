// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach } from "vitest";

const listHarnesses = vi.fn();
const refreshRouteCatalog = vi.fn();
const setConfig = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ListHarnessesCommand: (...a: any[]) => listHarnesses(...a),
        RefreshRouteCatalogCommand: (...a: any[]) => refreshRouteCatalog(...a),
        SetConfigCommand: (...a: any[]) => setConfig(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/global";
import { harnessPreferenceAtom, harnessesAtom, initHarnessPreference, loadHarnesses, setPreferredHarness, setPreferredRoute } from "./harnessstore";

describe("harnessstore model catalog freshness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalStore.set(harnessesAtom, []);
        globalStore.set(harnessPreferenceAtom, { route: null, persistedRoute: null, saving: false });
        listHarnesses.mockResolvedValue({ harnesses: [] });
        refreshRouteCatalog.mockResolvedValue(undefined);
        setConfig.mockResolvedValue(undefined);
    });

    it("refreshes the catalog before re-listing when forced", async () => {
        await loadHarnesses(true);
        expect(refreshRouteCatalog).toHaveBeenCalledTimes(1);
        expect(listHarnesses).toHaveBeenCalledTimes(1);
        expect(refreshRouteCatalog.mock.invocationCallOrder[0]).toBeLessThan(listHarnesses.mock.invocationCallOrder[0]);
    });

    it("does not refresh when not forced", async () => {
        await loadHarnesses();
        expect(refreshRouteCatalog).not.toHaveBeenCalled();
        expect(listHarnesses).toHaveBeenCalledTimes(1);
    });

    it("persists model in the route settings patch", async () => {
        setPreferredRoute({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" });
        await vi.waitFor(() => expect(setConfig).toHaveBeenCalled());
        const patch = setConfig.mock.calls[0][1] as Record<string, string>;
        expect(patch["harness:preferredmodel"]).toBe("opencode/deepseek-v4-pro");
        expect(patch["harness:preferredruntime"]).toBe("pi");
    });

    it("treats a model-only change as a change worth saving", async () => {
        initHarnessPreference("pi", "capable");
        setPreferredRoute({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" });
        await vi.waitFor(() => expect(setConfig).toHaveBeenCalled());
        expect(setConfig.mock.calls[0][1]["harness:preferredmodel"]).toBe("opencode/deepseek-v4-pro");
    });

    it("keeps the pinned model when the harness picker re-picks the current runtime", () => {
        globalStore.set(harnessesAtom, [
            { runtime: "pi", label: "Pi", routecapabilities: [{ runtime: "pi", tier: "capable", resolvedmodel: "operator default" }] },
            { runtime: "codex", label: "Codex", routecapabilities: [{ runtime: "codex", tier: "capable", resolvedmodel: "operator default" }] },
        ] as HarnessInfo[]);
        initHarnessPreference("pi", "capable", "opencode/deepseek-v4-pro");

        setPreferredHarness("pi");
        expect(globalStore.get(harnessPreferenceAtom).route).toEqual({ runtime: "pi", tier: "capable", model: "opencode/deepseek-v4-pro" });

        // a different harness has a different id namespace, so the model cannot come along
        setPreferredHarness("codex");
        expect(globalStore.get(harnessPreferenceAtom).route).toEqual({ runtime: "codex", tier: "capable" });
    });

    it("seeds the preference from a persisted model", () => {
        initHarnessPreference("pi", "capable", "opencode/deepseek-v4-pro");
        expect(globalStore.get(harnessPreferenceAtom).route).toEqual({
            runtime: "pi",
            tier: "capable",
            model: "opencode/deepseek-v4-pro",
        });
    });
});
