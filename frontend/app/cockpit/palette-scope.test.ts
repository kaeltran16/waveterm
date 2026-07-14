// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseScope, resolveChannelToken } from "./palette-scope";

describe("parseScope", () => {
    it("treats plain text as the default scope", () => {
        expect(parseScope("fix the auth bug")).toEqual({ scope: "default", sub: "", channelLaunch: null });
    });
    it("only triggers a scope when the sigil is the first char", () => {
        expect(parseScope("fix #123 bug").scope).toBe("default");
        expect(parseScope("see @claude later").scope).toBe("default");
    });
    it("maps each sigil to its scope with the remainder as sub", () => {
        expect(parseScope(">files")).toMatchObject({ scope: "command", sub: "files" });
        expect(parseScope("@auth")).toMatchObject({ scope: "agent", sub: "auth" });
        expect(parseScope("/main")).toMatchObject({ scope: "session", sub: "main" });
    });
    it("returns a bare scope (empty sub) for a lone sigil", () => {
        expect(parseScope(">")).toMatchObject({ scope: "command", sub: "" });
        expect(parseScope("@")).toMatchObject({ scope: "agent", sub: "" });
        expect(parseScope("#")).toMatchObject({ scope: "channel", sub: "", channelLaunch: null });
    });
    it("# with no goal is picker mode (channelLaunch null)", () => {
        expect(parseScope("#back")).toMatchObject({ scope: "channel", sub: "back", channelLaunch: null });
    });
    it("# with a trailing space but no goal stays picker mode", () => {
        expect(parseScope("#backend ")).toMatchObject({ scope: "channel", channelLaunch: null });
    });
    it("# with token + goal is launch mode", () => {
        expect(parseScope("#backend fix the auth bug")).toMatchObject({
            scope: "channel",
            channelLaunch: { token: "backend", goal: "fix the auth bug" },
        });
    });
    it("trims the launch goal", () => {
        expect(parseScope("#backend   fix auth  ").channelLaunch).toEqual({ token: "backend", goal: "fix auth" });
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
