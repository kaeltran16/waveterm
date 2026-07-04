// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { sourceKey } from "./filesmotion";

describe("sourceKey", () => {
    test("agent source → agent:<id>", () => {
        expect(sourceKey({ kind: "agent", id: "abc" })).toBe("agent:abc");
    });
    test("project source → project:<name>", () => {
        expect(sourceKey({ kind: "project", name: "waveterm" })).toBe("project:waveterm");
    });
    test("null source → undefined", () => {
        expect(sourceKey(null)).toBeUndefined();
    });
    test("agent and project with the same string do not collide", () => {
        expect(sourceKey({ kind: "agent", id: "x" })).not.toBe(sourceKey({ kind: "project", name: "x" }));
    });
});
