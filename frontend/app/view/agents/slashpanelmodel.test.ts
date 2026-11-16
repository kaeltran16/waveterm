// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    BUILTIN_COMMANDS,
    fromLive,
    insertSlash,
    slashGroups,
    slashMatches,
    slashQueryAt,
    type SlashCommand,
} from "./slashpanelmodel";

const cmd = (name: string, source: SlashCommand["source"] = "builtin", plugin?: string): SlashCommand => ({
    name,
    source,
    ...(plugin != null ? { plugin } : {}),
});
const names = (cs: SlashCommand[]) => cs.map((c) => c.name);

describe("slashQueryAt", () => {
    it("opens on a leading / with the command word up to the caret", () => {
        expect(slashQueryAt("/", 1)).toBe("");
        expect(slashQueryAt("/co", 3)).toBe("co");
        expect(slashQueryAt("/compact", 3)).toBe("co");
    });
    it("stays text for a / that does not lead, or a word already past", () => {
        expect(slashQueryAt("a/b", 3)).toBeNull();
        expect(slashQueryAt(" /x", 3)).toBeNull();
        expect(slashQueryAt("/x y", 4)).toBeNull();
        expect(slashQueryAt("/src/app", 8)).toBeNull();
    });
});

describe("slashMatches", () => {
    const all = [cmd("discord", "mcp"), cmd("context"), cmd("compact"), cmd("doctor"), cmd("config"), cmd("COST")];
    it("ranks prefix matches before substring matches, each in the list's order, ignoring case", () => {
        expect(names(slashMatches("co", all))).toEqual(["context", "compact", "config", "COST", "discord"]);
        expect(names(slashMatches("CT", all))).toEqual(["compact", "doctor"]);
    });
    it("lists every command for an empty query and none for no match", () => {
        expect(names(slashMatches("", all))).toEqual(names(all));
        expect(slashMatches("zzz", all)).toEqual([]);
    });
});

describe("slashGroups", () => {
    it("orders Built-in, Skills, Plugins, MCP and drops the empty groups", () => {
        const groups = slashGroups([cmd("mcp__x__p", "mcp"), cmd("my-skill", "user"), cmd("clear")]);
        expect(groups.map((g) => g.title)).toEqual(["Built-in", "Skills", "MCP"]);
        expect(groups.map((g) => names(g.items))).toEqual([["clear"], ["my-skill"], ["mcp__x__p"]]);
    });
    it("puts plugin commands under Plugins, in the input's order", () => {
        const groups = slashGroups([cmd("sp:b", "plugin", "sp"), cmd("init"), cmd("sp:a", "plugin", "sp")]);
        expect(groups.map((g) => g.title)).toEqual(["Built-in", "Plugins"]);
        expect(names(groups[1].items)).toEqual(["sp:b", "sp:a"]);
    });
    it("keeps the first entry of a duplicate name", () => {
        const groups = slashGroups([cmd("review", "user"), cmd("review", "plugin", "p"), cmd("clear")]);
        expect(groups.map((g) => g.title)).toEqual(["Built-in", "Skills"]);
        expect(groups[1].items).toEqual([cmd("review", "user")]);
    });
});

describe("fromLive", () => {
    it("keeps the known sources and the plugin, and maps an unknown source to Skills", () => {
        const got = fromLive([
            { name: "clear", description: "Start over", source: "builtin" },
            { name: "sp:a", source: "plugin", plugin: "sp" },
            { name: "odd", source: "something-new" },
        ]);
        expect(got).toEqual([
            { name: "clear", description: "Start over", source: "builtin" },
            { name: "sp:a", source: "plugin", plugin: "sp" },
            { name: "odd", source: "user" },
        ]);
        expect(slashGroups(got).map((g) => g.title)).toEqual(["Built-in", "Skills", "Plugins"]);
    });
});

describe("BUILTIN_COMMANDS", () => {
    it("are all built-ins with a description", () => {
        expect(BUILTIN_COMMANDS.length).toBeGreaterThan(0);
        for (const c of BUILTIN_COMMANDS) {
            expect(c.source).toBe("builtin");
            expect(c.description).toBeTruthy();
        }
    });
});

describe("insertSlash", () => {
    it("replaces the typed word with /name and a space, caret after it", () => {
        expect(insertSlash("/co", 3, "compact")).toEqual({ text: "/compact ", caret: 9 });
    });
    it("replaces the whole word the caret sits in and keeps the rest of the text", () => {
        expect(insertSlash("/cofoo keep this", 3, "compact")).toEqual({ text: "/compact keep this", caret: 9 });
        expect(insertSlash("/co\nnext", 3, "config")).toEqual({ text: "/config \nnext", caret: 8 });
    });
});
