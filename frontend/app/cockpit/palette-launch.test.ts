// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";

function mkDeps(): LaunchDeps & {
    quick: ReturnType<typeof vi.fn>;
    orchestrate: ReturnType<typeof vi.fn>;
    consult: ReturnType<typeof vi.fn>;
} {
    return { quick: vi.fn(), orchestrate: vi.fn(), consult: vi.fn() } as any;
}

describe("buildLaunchItems", () => {
    it("returns [] with no goal", () => {
        expect(buildLaunchItems("   ", "payments-api", mkDeps())).toEqual([]);
    });
    it("returns [] with no active channel", () => {
        expect(buildLaunchItems("fix auth", undefined, mkDeps())).toEqual([]);
    });
    it("produces the 4 keyed rows in order, Quick first", () => {
        const items = buildLaunchItems("fix auth", "payments-api", mkDeps());
        expect(items.map((i) => i.key)).toEqual([
            "launch:quick",
            "launch:orchestrate",
            "launch:consult:claude",
            "launch:consult:pi",
        ]);
    });

    it("starts a quick run with the trimmed goal", () => {
        const deps = mkDeps();
        buildLaunchItems("  fix auth  ", "ch", deps)
            .find((i) => i.key === "launch:quick")!
            .run();
        expect(deps.quick).toHaveBeenCalledWith("fix auth");
    });
    // Run used to send no mode, which the server defaults to Quick: two rows doing one thing
    it("orchestrates with the trimmed goal, a different action from Quick", () => {
        const deps = mkDeps();
        buildLaunchItems("  fix auth  ", "ch", deps)
            .find((i) => i.key === "launch:orchestrate")!
            .run();
        expect(deps.orchestrate).toHaveBeenCalledWith("fix auth");
        expect(deps.quick).not.toHaveBeenCalled();
    });
    it("consults claude and pi with the trimmed goal", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", deps);
        items.find((i) => i.key === "launch:consult:claude")!.run();
        items.find((i) => i.key === "launch:consult:pi")!.run();
        expect(deps.consult).toHaveBeenNthCalledWith(1, "claude", "fix auth");
        expect(deps.consult).toHaveBeenNthCalledWith(2, "pi", "fix auth");
    });

    it("says what each row does, with the verb Enter shows", () => {
        const items = buildLaunchItems("g", "ch", mkDeps());
        expect(items.map((i) => i.verb)).toEqual(["Start", "Start", "Ask", "Ask"]);
        expect(items[1].echo).toBe("Starts an orchestrator run on “g” in #ch");
        expect(items[3].echo).toBe("Asks pi about “g”, nothing is spawned");
    });
});
