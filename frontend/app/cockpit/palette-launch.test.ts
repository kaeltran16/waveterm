// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";

function mkDeps(): LaunchDeps & {
    quick: ReturnType<typeof vi.fn>;
    orchestrate: ReturnType<typeof vi.fn>;
    consult: ReturnType<typeof vi.fn>;
    setup: ReturnType<typeof vi.fn>;
} {
    return { quick: vi.fn(), orchestrate: vi.fn(), consult: vi.fn(), setup: vi.fn() } as any;
}

describe("buildLaunchItems", () => {
    it("returns [] with no goal", () => {
        expect(buildLaunchItems("   ", "payments-api", mkDeps())).toEqual([]);
    });
    it("returns [] with no active channel", () => {
        expect(buildLaunchItems("fix auth", undefined, mkDeps())).toEqual([]);
    });
    it("produces the 5 keyed rows in order, Quick first", () => {
        const items = buildLaunchItems("fix auth", "payments-api", mkDeps());
        expect(items.map((i) => i.key)).toEqual([
            "launch:quick",
            "launch:orchestrate",
            "launch:setup",
            "launch:consult:claude",
            "launch:consult:pi",
        ]);
    });

    it("orchestrates from any other row of the block on Ctrl+Enter", () => {
        const deps = mkDeps();
        const items = buildLaunchItems("  fix auth  ", "ch", deps);
        const others = items.filter((i) => i.key !== "launch:orchestrate");
        expect(others.every((i) => i.alt != null)).toBe(true);
        items.find((i) => i.key === "launch:consult:pi")!.alt!.run();
        expect(deps.orchestrate).toHaveBeenCalledWith("fix auth");
        expect(deps.consult).not.toHaveBeenCalled();
        expect(items.find((i) => i.key === "launch:orchestrate")!.chord).toBe("Ctrl:Enter");
    });

    it("sets up the run in the New run window with the goal, as an orchestrator run", () => {
        const deps = mkDeps();
        const setup = buildLaunchItems("  fix auth  ", "ch", deps).find((i) => i.key === "launch:setup")!;
        setup.run();
        expect(deps.setup).toHaveBeenCalledWith("fix auth", "orchestrator");
        expect(deps.quick).not.toHaveBeenCalled();
        expect(deps.orchestrate).not.toHaveBeenCalled();
        expect(setup.echo).toBe("Opens the New run window with the goal and #ch filled in");
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
        expect(items.map((i) => i.verb)).toEqual(["Start", "Start", "Open", "Ask", "Ask"]);
        expect(items[1].echo).toBe("Starts an orchestrator run on “g” in #ch");
        expect(items[4].echo).toBe("Asks pi about “g”, nothing is spawned");
    });
});
