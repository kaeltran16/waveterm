// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    backspaceEmpty,
    cycleScope,
    initialNav,
    openDrill,
    parseProjectLaunch,
    resolveChannelToken,
    SCOPES,
    typeQuery,
    type NavState,
} from "./palette-scope";

const nav = (over: Partial<NavState> = {}): NavState => ({ ...initialNav("cockpit"), ...over });

describe("initialNav", () => {
    it("opens on All everywhere but Code, where the file finder folds in as Files", () => {
        expect(initialNav("cockpit").scope).toBe("all");
        expect(initialNav("files").scope).toBe("all");
        expect(initialNav("code").scope).toBe("files");
    });
});

describe("typeQuery", () => {
    it("turns a sigil typed into an empty All query into its chip", () => {
        expect(typeQuery(nav(), "@")).toMatchObject({ scope: "agents", query: "" });
        expect(typeQuery(nav(), "/")).toMatchObject({ scope: "sessions", query: "" });
        expect(typeQuery(nav(), "#")).toMatchObject({ scope: "projects", query: "" });
        expect(typeQuery(nav(), ">")).toMatchObject({ scope: "commands", query: "" });
    });
    it("keeps the rest of a pasted sigil query as the filter", () => {
        expect(typeQuery(nav(), "@juno")).toMatchObject({ scope: "agents", query: "juno" });
    });
    it("leaves a sigil mid-query as text, so a goal like 'fix #123' stays a goal", () => {
        expect(typeQuery(nav({ query: "fix " }), "fix #")).toMatchObject({ scope: "all", query: "fix #" });
    });
    it("leaves a sigil as text inside a narrowed scope", () => {
        expect(typeQuery(nav({ scope: "files" }), "#")).toMatchObject({ scope: "files", query: "#" });
    });
    it("drops a chosen 'as a goal' once the text changes", () => {
        expect(typeQuery(nav({ query: "rad", asGoal: true }), "rada").asGoal).toBe(false);
    });
});

describe("cycleScope", () => {
    it("walks the chips in order and wraps both ways", () => {
        expect(cycleScope(nav(), 1).scope).toBe(SCOPES[1].id);
        expect(cycleScope(nav(), -1).scope).toBe(SCOPES[SCOPES.length - 1].id);
    });
    it("keeps the query and leaves any drill", () => {
        const s = cycleScope(nav({ scope: "commands", drill: "theme", query: "mono" }), 1);
        expect(s).toMatchObject({ query: "mono", drill: null });
    });
});

describe("backspaceEmpty", () => {
    it("does nothing while there is text to delete", () => {
        expect(backspaceEmpty(nav({ scope: "runs", query: "x" }))).toBeNull();
    });
    it("leaves a drill before it leaves the scope", () => {
        const inDrill = openDrill(nav(), "theme");
        const out = backspaceEmpty(inDrill)!;
        expect(out).toMatchObject({ scope: "commands", drill: null });
        expect(backspaceEmpty(out)).toMatchObject({ scope: "all" });
    });
    it("has nothing to leave on an empty All", () => {
        expect(backspaceEmpty(nav())).toBeNull();
    });
});

describe("parseProjectLaunch", () => {
    it("is picker mode for a lone token", () => {
        expect(parseProjectLaunch("back")).toBeNull();
        expect(parseProjectLaunch("backend ")).toBeNull();
    });
    it("splits a token and a trimmed goal", () => {
        expect(parseProjectLaunch("backend   fix auth  ")).toEqual({ token: "backend", goal: "fix auth" });
    });
});

describe("resolveChannelToken", () => {
    const channels = [{ name: "backend-api" }, { name: "frontend" }, { name: "Payments" }];
    it("matches an exact name case-insensitively", () => {
        expect(resolveChannelToken("payments", channels)).toEqual({ name: "Payments" });
    });
    it("falls back to the best fuzzy match", () => {
        expect(resolveChannelToken("backend", channels)).toEqual({ name: "backend-api" });
    });
    it("returns undefined when nothing matches", () => {
        expect(resolveChannelToken("zzzzz", channels)).toBeUndefined();
    });
});
