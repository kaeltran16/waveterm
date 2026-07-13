// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";

function mkDeps(): LaunchDeps & {
    dispatch: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    consult: ReturnType<typeof vi.fn>;
} {
    return { dispatch: vi.fn(), run: vi.fn(), consult: vi.fn() } as any;
}

describe("buildLaunchItems", () => {
    it("returns [] with no goal", () => {
        expect(buildLaunchItems("   ", "payments-api", "pipeline", mkDeps())).toEqual([]);
    });
    it("returns [] with no active channel", () => {
        expect(buildLaunchItems("fix auth", undefined, "pipeline", mkDeps())).toEqual([]);
    });
    it("produces the 4 keyed rows in order", () => {
        const items = buildLaunchItems("fix auth", "payments-api", "pipeline", mkDeps());
        expect(items.map((i) => i.key)).toEqual([
            "launch:quick",
            "launch:run",
            "launch:consult:claude",
            "launch:consult:codex",
        ]);
    });

    it("dispatches Quick to claude with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", "pipeline", deps);
        items.find((i) => i.key === "launch:quick")!.run();
        expect(deps.dispatch).toHaveBeenCalledWith("claude", "fix auth");
    });
    it("runs a managed run with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", "pipeline", deps);
        items.find((i) => i.key === "launch:run")!.run();
        expect(deps.run).toHaveBeenCalledWith("fix auth");
    });
    it("consults claude and codex with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", "pipeline", deps);
        items.find((i) => i.key === "launch:consult:claude")!.run();
        items.find((i) => i.key === "launch:consult:codex")!.run();
        expect(deps.consult).toHaveBeenNthCalledWith(1, "claude", "fix auth");
        expect(deps.consult).toHaveBeenNthCalledWith(2, "codex", "fix auth");
    });

    it("labels the Run row with the resolved strategy suffix", () => {
        const run = buildLaunchItems("g", "ch", "orchestrator", mkDeps()).find((i) => i.key === "launch:run")!;
        expect(run.suffix).toBe(" · orchestrator");
        expect(run.desc).toBe("managed run · channel strategy");
    });
    it("labels the Run row plainly before the strategy resolves", () => {
        const run = buildLaunchItems("g", "ch", undefined, mkDeps()).find((i) => i.key === "launch:run")!;
        expect(run.suffix).toBe("");
        expect(run.desc).toBe("resolving channel strategy…");
    });
    it("preselects Quick (first row)", () => {
        expect(buildLaunchItems("g", "ch", "pipeline", mkDeps())[0].key).toBe("launch:quick");
    });
});
