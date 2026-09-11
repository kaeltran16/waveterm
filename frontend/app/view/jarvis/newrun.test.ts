// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RunConfig } from "./newrun";
import { launchOptsFromConfig, rankProjects, resolveChannelTarget, stepPick } from "./newrun";

const ch = (oid: string, projectpath: string): Channel => ({ oid, projectpath }) as Channel;

describe("resolveChannelTarget", () => {
    it("reuses the channel already bound to the project's path", () => {
        const channels = [ch("c1", "/repo/a"), ch("c2", "/repo/b")];
        expect(resolveChannelTarget(channels, "b", "/repo/b")).toEqual({ kind: "existing", oid: "c2" });
    });

    it("matches across separator styles, so a Windows path does not mint a duplicate", () => {
        const channels = [ch("c1", "C:\\Users\\k\\waveterm")];
        expect(resolveChannelTarget(channels, "waveterm", "C:/Users/k/waveterm")).toEqual({
            kind: "existing",
            oid: "c1",
        });
    });

    it("creates one named after the project when the project has none", () => {
        expect(resolveChannelTarget([ch("c1", "/repo/a")], "b", "/repo/b")).toEqual({
            kind: "create",
            name: "b",
            path: "/repo/b",
        });
    });

    it("creates one when there are no channels at all", () => {
        expect(resolveChannelTarget([], "b", "/repo/b")).toEqual({ kind: "create", name: "b", path: "/repo/b" });
    });

    it("refuses to decide while the channel list is still unread", () => {
        expect(resolveChannelTarget(null, "b", "/repo/b")).toBeNull();
    });
});

describe("launchOptsFromConfig", () => {
    const base = { shape: "quick", orchestration: "adaptive", parallelism: 3, workerRoute: null } as RunConfig;

    it("names the mode rather than leaving the server to default it to quick", () => {
        expect(launchOptsFromConfig({ ...base, shape: "pipeline" })).toEqual({ mode: "pipeline" });
    });

    it("drops the engine dials on a shape that has no fan-out", () => {
        const workerRoute: RoutePin = { runtime: "claude", tier: "capable" };
        expect(launchOptsFromConfig({ ...base, shape: "pipeline", parallelism: 6, workerRoute })).toEqual({
            mode: "pipeline",
        });
    });

    it("carries the width and the worker route for an engine orchestrator", () => {
        const workerRoute: RoutePin = { runtime: "claude", tier: "capable" };
        expect(
            launchOptsFromConfig({ shape: "orchestrator", orchestration: "engine", parallelism: 4, workerRoute })
        ).toEqual({ mode: "orchestrator", orchestration: "engine", parallelism: 4, workerRoute });
    });

    it("withholds the width and the worker route from an adaptive lead, which fans out on its own", () => {
        const workerRoute: RoutePin = { runtime: "claude", tier: "capable" };
        expect(
            launchOptsFromConfig({ shape: "orchestrator", orchestration: "adaptive", parallelism: 4, workerRoute })
        ).toEqual({ mode: "orchestrator", orchestration: "adaptive" });
    });

    it("omits a worker route the launcher left inheriting the lead", () => {
        expect(
            launchOptsFromConfig({ shape: "orchestrator", orchestration: "engine", parallelism: 2, workerRoute: null })
        ).toEqual({ mode: "orchestrator", orchestration: "engine", parallelism: 2 });
    });
});

describe("rankProjects", () => {
    const names = ["git-compare-parity", "waveterm", "wave-docs", "waveterm-b6"];

    it("keeps the registry's own order when nothing is typed", () => {
        expect(rankProjects(names, "")).toEqual(names);
        expect(rankProjects(names, "   ")).toEqual(names);
    });

    it("drops projects the query cannot match", () => {
        expect(rankProjects(names, "wave")).not.toContain("git-compare-parity");
    });

    it("ranks the tightest match first", () => {
        expect(rankProjects(names, "waveterm")[0]).toBe("waveterm");
    });

    it("matches on subsequences, not just prefixes", () => {
        expect(rankProjects(names, "wdocs")).toContain("wave-docs");
    });

    it("returns nothing when the query matches no project", () => {
        expect(rankProjects(names, "zzzz")).toEqual([]);
    });

    it("has nothing to rank in an empty registry", () => {
        expect(rankProjects([], "wave")).toEqual([]);
    });
});

describe("stepPick", () => {
    const rows = ["a", "b", "c"];

    it("starts at the first row when nothing is picked and the move is forward", () => {
        expect(stepPick(rows, null, 1)).toBe("a");
    });

    it("starts at the last row when nothing is picked and the move is backward", () => {
        expect(stepPick(rows, null, -1)).toBe("c");
    });

    it("moves forward and backward through the rows", () => {
        expect(stepPick(rows, "a", 1)).toBe("b");
        expect(stepPick(rows, "b", -1)).toBe("a");
    });

    it("wraps at both ends", () => {
        expect(stepPick(rows, "c", 1)).toBe("a");
        expect(stepPick(rows, "a", -1)).toBe("c");
    });

    it("restarts when the filter has removed the current pick", () => {
        expect(stepPick(rows, "gone", 1)).toBe("a");
        expect(stepPick(rows, "gone", -1)).toBe("c");
    });

    it("has nothing to pick when the filter left no rows", () => {
        expect(stepPick([], "a", 1)).toBeNull();
    });
});
