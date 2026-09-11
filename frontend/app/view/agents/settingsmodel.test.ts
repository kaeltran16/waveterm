// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RUNTIME_FLAGS } from "./launch";
import {
    changedCount,
    countLabel,
    filterSections,
    flagRowId,
    groupSections,
    resolveSelection,
    rowMatches,
    SECTION_EMBEDDINGS,
    settingsSections,
    type SettingSectionDef,
} from "./settingsmodel";

const sections = () => settingsSections("claude");

describe("settingsSections", () => {
    it("gives every row a unique id", () => {
        const ids = sections().flatMap((s) => s.rows.map((r) => r.id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("lists the flags of the runtime being edited, and only those", () => {
        const rows = sections().find((s) => s.id === "newagent")!.rows;
        expect(rows.map((r) => r.id)).toEqual([
            "newagent.remember",
            "newagent.runtime",
            ...RUNTIME_FLAGS.claude.map((f) => flagRowId("claude", f.id)),
        ]);
        const codex = settingsSections("codex").find((s) => s.id === "newagent")!.rows;
        expect(codex.some((r) => r.title === "--verbose")).toBe(false);
    });

    it("renders a runtime with an empty flag catalog as a section with no flag rows", () => {
        const rows = settingsSections("pi").find((s) => s.id === "newagent")!.rows;
        expect(rows.map((r) => r.id)).toEqual(["newagent.remember", "newagent.runtime"]);
    });

    it("keeps the embeddings deep-link target pointing at a real section", () => {
        expect(sections().some((s) => s.id === SECTION_EMBEDDINGS)).toBe(true);
    });

    it("leaves read-only build info without a provenance scope", () => {
        const about = sections().find((s) => s.id === "about")!;
        expect(about.rows.every((r) => r.scope === undefined)).toBe(true);
    });

    it("marks exactly the wconfig-backed rows as config rows", () => {
        const rows = sections().flatMap((s) => s.rows);
        const config = rows.filter((r) => r.config).map((r) => r.key);
        expect(config).toEqual([
            "term:fontfamily",
            "term:fontsize",
            "term:cursor",
            "term:cursorblink",
            "term:scrollback",
            "term:copyonselect",
            "memory:vaultpath",
            "jarvis:embedenabled",
            "jarvis:embedbaseurl",
            "jarvis:embedmodel",
            "headless:runtime",
            "headless:openroutercheapmodel",
            "headless:openroutermidmodel",
            "headless:openrouterlongmodel",
        ]);
    });

    it("leaves the backend-authoritative run route off the config path", () => {
        const route = sections()
            .find((s) => s.id === "run")!
            .rows.find((r) => r.id === "run.route")!;
        expect(route.scope).toBe("synced");
        expect(route.config).toBeUndefined();
    });

    it("puts every section in a known group", () => {
        const grouped = groupSections(sections()).flatMap((g) => g.sections);
        expect(grouped).toHaveLength(sections().length);
    });
});

describe("rowMatches", () => {
    const row = { id: "terminal.fontsize", title: "Font size", desc: "Default font size (px).", key: "term:fontsize" };

    it("matches an empty query", () => {
        expect(rowMatches(row, "   ")).toBe(true);
    });

    it("matches on title, description and config key, case-insensitively", () => {
        expect(rowMatches(row, "FONT")).toBe(true);
        expect(rowMatches(row, "px")).toBe(true);
        expect(rowMatches(row, "term:fontsize")).toBe(true);
    });

    it("does not match unrelated text", () => {
        expect(rowMatches(row, "scrollback")).toBe(false);
    });
});

describe("filterSections", () => {
    it("returns the sections untouched for an empty query", () => {
        const all = sections();
        expect(filterSections(all, "")).toBe(all);
    });

    it("drops non-matching rows and then empty sections", () => {
        const found = filterSections(sections(), "scrollback");
        expect(found.map((s) => s.id)).toEqual(["terminal"]);
        expect(found[0].rows.map((r) => r.id)).toEqual(["terminal.scrollback"]);
    });

    it("reaches rows in sections the query does not name", () => {
        const found = filterSections(sections(), "caret");
        expect(found.map((s) => s.id)).toEqual(["terminal"]);
        expect(found[0].rows.map((r) => r.id)).toEqual(["terminal.cursor", "terminal.cursorblink"]);
    });

    it("returns nothing when no row matches", () => {
        expect(filterSections(sections(), "zzzz")).toEqual([]);
    });
});

describe("resolveSelection", () => {
    it("keeps the wanted section when it survived the filter", () => {
        expect(resolveSelection(sections(), "terminal")).toBe("terminal");
    });

    it("falls back to the first surviving section", () => {
        expect(resolveSelection(filterSections(sections(), "scrollback"), "about")).toBe("terminal");
    });

    it("returns null when the filter emptied the list", () => {
        expect(resolveSelection([], "terminal")).toBeNull();
    });
});

describe("changedCount", () => {
    const section: SettingSectionDef = {
        id: "terminal",
        name: "Terminal",
        blurb: "",
        group: "Agents",
        rows: [
            { id: "a", title: "A", desc: "", key: "a" },
            { id: "b", title: "B", desc: "", key: "b" },
        ],
    };

    it("counts only this section's changed rows", () => {
        expect(changedCount(section, new Set(["a", "elsewhere"]))).toBe(1);
        expect(changedCount(section, new Set())).toBe(0);
    });
});

describe("countLabel", () => {
    it("singularizes one", () => {
        expect(countLabel(1)).toBe("1 setting");
        expect(countLabel(4)).toBe("4 settings");
    });
});
