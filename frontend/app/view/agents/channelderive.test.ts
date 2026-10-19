// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { partitionChannels, resolveTargetChannel } from "./channelderive";

describe("partitionChannels", () => {
    const ch = (name: string, archived?: boolean): Channel =>
        ({
            oid: name,
            name,
            createdts: 0,
            messages: [],
            meta: archived ? { archived: true } : {},
        }) as unknown as Channel;
    it("puts everything in active when nothing is archived", () => {
        const { active, archived } = partitionChannels([ch("a"), ch("b")]);
        expect(active.map((c) => c.name)).toEqual(["a", "b"]);
        expect(archived).toHaveLength(0);
    });
    it("splits archived out of active, preserving order", () => {
        const { active, archived } = partitionChannels([ch("a"), ch("b", true), ch("c")]);
        expect(active.map((c) => c.name)).toEqual(["a", "c"]);
        expect(archived.map((c) => c.name)).toEqual(["b"]);
    });
});

const ch = (oid: string, projectpath: string): Channel => ({ oid, projectpath }) as Channel;

describe("resolveTargetChannel", () => {
    it("returns the first channel matching the project path", () => {
        const channels = [ch("c1", "/repo/a"), ch("c2", "/repo/b"), ch("c3", "/repo/b")];
        expect(resolveTargetChannel(channels, "/repo/b")?.oid).toBe("c2");
    });
    it("ignores a trailing slash on either side", () => {
        expect(resolveTargetChannel([ch("c1", "/repo/a/")], "/repo/a")?.oid).toBe("c1");
        expect(resolveTargetChannel([ch("c1", "/repo/a")], "/repo/a/")?.oid).toBe("c1");
    });
    it("matches across path-separator styles (Windows channel path vs canonPath report path)", () => {
        // Channels store the registry path verbatim (backslashes on Windows); radar report paths are
        // canonPath'd to forward slashes. The compare must normalize separators or the handoff never lands.
        expect(resolveTargetChannel([ch("c1", "C:\\Users\\me\\repo")], "C:/Users/me/repo")?.oid).toBe("c1");
        expect(resolveTargetChannel([ch("c1", "C:/Users/me/repo")], "C:\\Users\\me\\repo")?.oid).toBe("c1");
    });
    it("returns undefined when nothing matches or the path is missing", () => {
        expect(resolveTargetChannel([ch("c1", "/repo/a")], "/repo/z")).toBeUndefined();
        expect(resolveTargetChannel([ch("c1", "/repo/a")], undefined)).toBeUndefined();
    });
});
