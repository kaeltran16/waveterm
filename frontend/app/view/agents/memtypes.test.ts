// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupByScope, reasonMeta, relativeAge, typeMeta, type MemNote } from "./memtypes";

const note = (over: Partial<MemNote>): MemNote => ({
    id: "x",
    title: "X",
    description: "",
    type: "project",
    scope: "shared",
    source: "vault",
    path: "/v/x.md",
    links: [],
    updatedts: 0,
    reviewed: false,
    capturedat: "",
    supersededby: "",
    lastreferenced: "",
    ...over,
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

describe("reasonMeta", () => {
    it("colors upkeep reasons by severity, not by note type", () => {
        expect(reasonMeta("superseded").textClass).toBe("text-error");
        expect(reasonMeta("drift").textClass).toBe("text-warning");
        // stale (cleanup), decay (archive) and duplicate are all neutral
        expect(reasonMeta("stale").textClass).toBe("text-ink-mid");
        expect(reasonMeta("decay").textClass).toBe("text-ink-mid");
        expect(reasonMeta("duplicate").textClass).toBe("text-ink-mid");
    });
    it("falls back to neutral for unknown reasons", () => {
        expect(reasonMeta("").textClass).toBe("text-ink-mid");
        expect(reasonMeta("weird").bgClass).toBe("bg-ink-mid/10");
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

describe("relativeAge", () => {
    const now = Date.parse("2026-07-12T12:00:00Z");
    it("returns empty for missing or unparseable input", () => {
        expect(relativeAge("", now)).toBe("");
        expect(relativeAge("not-a-date", now)).toBe("");
    });
    it("buckets recent times", () => {
        expect(relativeAge("2026-07-12T11:59:30Z", now)).toBe("just now");
        expect(relativeAge("2026-07-12T11:56:00Z", now)).toBe("4m ago");
        expect(relativeAge("2026-07-12T11:00:00Z", now)).toBe("1h ago");
        expect(relativeAge("2026-07-10T12:00:00Z", now)).toBe("2d ago");
    });
});
