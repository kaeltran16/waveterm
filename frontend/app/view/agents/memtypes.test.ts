// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupByScope, typeMeta, type MemNote } from "./memtypes";

const note = (over: Partial<MemNote>): MemNote => ({
    id: "x", title: "X", description: "", type: "project", scope: "shared",
    source: "vault", path: "/v/x.md", links: [], updatedts: 0,
    reviewed: false, capturedat: "", supersededby: "", lastreferenced: "", ...over,
});

describe("typeMeta", () => {
    it("labels and colors the four Claude types", () => {
        expect(typeMeta("project").label).toBe("Project");
        expect(typeMeta("project").dotClass).toBe("bg-mem-project");
        expect(typeMeta("user").label).toBe("User");
    });
    it("maps the learning type to its own label", () => {
        expect(typeMeta("learning").label).toBe("Learning");
    });
    it("falls back for unknown/empty types", () => {
        expect(typeMeta("").label).toBe("Note");
        expect(typeMeta("weird").dotClass).toBe("bg-ink-mid");
    });
});

describe("groupByScope", () => {
    it("groups notes by scope, shared first, then alpha, with counts", () => {
        const groups = groupByScope([
            note({ id: "a", scope: "payments-api" }),
            note({ id: "b", scope: "shared" }),
            note({ id: "c", scope: "payments-api" }),
        ]);
        expect(groups.map((g) => g.name)).toEqual(["shared", "payments-api"]);
        expect(groups[1].count).toBe(2);
    });
});
