// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";

function mkDeps(): LaunchDeps & {
    quick: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    consult: ReturnType<typeof vi.fn>;
} {
    return { quick: vi.fn(), run: vi.fn(), consult: vi.fn() } as any;
}

describe("buildLaunchItems", () => {
    it("returns [] with no goal", () => {
        expect(buildLaunchItems("   ", "payments-api", mkDeps())).toEqual([]);
    });
    it("returns [] with no active channel", () => {
        expect(buildLaunchItems("fix auth", undefined, mkDeps())).toEqual([]);
    });
    it("produces the 4 keyed rows in order", () => {
        const items = buildLaunchItems("fix auth", "payments-api", mkDeps());
        expect(items.map((i) => i.key)).toEqual([
            "launch:quick",
            "launch:run",
            "launch:consult:claude",
            "launch:consult:codex",
        ]);
    });

    it("starts a quick run with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", deps);
        items.find((i) => i.key === "launch:quick")!.run();
        expect(deps.quick).toHaveBeenCalledWith("fix auth");
    });
    it("starts a default run with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", deps);
        items.find((i) => i.key === "launch:run")!.run();
        expect(deps.run).toHaveBeenCalledWith("fix auth");
    });
    it("consults claude and codex with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", deps);
        items.find((i) => i.key === "launch:consult:claude")!.run();
        items.find((i) => i.key === "launch:consult:codex")!.run();
        expect(deps.consult).toHaveBeenNthCalledWith(1, "claude", "fix auth");
        expect(deps.consult).toHaveBeenNthCalledWith(2, "codex", "fix auth");
    });

    it("describes the Quick default without fetching a profile", () => {
        const run = buildLaunchItems("g", "ch", mkDeps()).find((i) => i.key === "launch:run")!;
        expect(run.suffix).toBe(" · quick");
        expect(run.desc).toBe("one worker · no plan gate");
        expect(run.footer).toBe("Starts a quick run on “g” in #ch");
    });
    it("preselects Quick (first row)", () => {
        expect(buildLaunchItems("g", "ch", mkDeps())[0].key).toBe("launch:quick");
    });
});
