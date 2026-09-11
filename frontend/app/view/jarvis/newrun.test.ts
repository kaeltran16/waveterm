// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { launchOptsFromProfile, resolveChannelTarget } from "./newrun";

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

describe("launchOptsFromProfile", () => {
    it("falls back to quick when the profile names no shape", () => {
        expect(launchOptsFromProfile(null)).toEqual({ mode: "quick" });
        expect(launchOptsFromProfile({} as JarvisProfile)).toEqual({ mode: "quick" });
    });

    it("sends the profile's shape rather than letting the server default it to quick", () => {
        expect(launchOptsFromProfile({ defaultmode: "pipeline" } as JarvisProfile)).toEqual({ mode: "pipeline" });
    });

    it("drops the engine dials on a non-orchestrator launch", () => {
        const profile = { defaultmode: "pipeline", machine: "engine", parallelism: 4 } as JarvisProfile;
        expect(launchOptsFromProfile(profile)).toEqual({ mode: "pipeline" });
    });

    it("carries the machine, width and worker route on an orchestrator launch", () => {
        const workerroute: RoutePin = { runtime: "claude", tier: "capable" };
        const profile = {
            defaultmode: "orchestrator",
            machine: "engine",
            parallelism: 3,
            workerroute,
        } as JarvisProfile;
        expect(launchOptsFromProfile(profile)).toEqual({
            mode: "orchestrator",
            orchestration: "engine",
            parallelism: 3,
            workerRoute: workerroute,
        });
    });

    it("omits dials the profile leaves unset", () => {
        expect(launchOptsFromProfile({ defaultmode: "orchestrator" } as JarvisProfile)).toEqual({
            mode: "orchestrator",
        });
    });
});
