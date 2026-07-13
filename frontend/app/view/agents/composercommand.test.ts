// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { LAUNCH_COMMANDS, parseComposerCommand, runFooterFor } from "./composercommand";

describe("parseComposerCommand", () => {
    it("defaults a bare goal to run", () => {
        expect(parseComposerCommand("fix auth token refresh")).toEqual({ mode: "run", body: "fix auth token refresh" });
    });
    it("parses @quick", () => {
        expect(parseComposerCommand("@quick add a spinner")).toEqual({ mode: "quick", body: "add a spinner" });
    });
    it("parses @run and strips the command", () => {
        expect(parseComposerCommand("@run migrate totals")).toEqual({ mode: "run", body: "migrate totals" });
    });
    it("parses @ask with default runtime", () => {
        expect(parseComposerCommand("@ask where is cart total computed?")).toEqual({ mode: "ask", body: "where is cart total computed?" });
    });
    it("parses @ask <runtime> override", () => {
        expect(parseComposerCommand("@ask codex any coupon validation?")).toEqual({ mode: "ask", runtime: "codex", body: "any coupon validation?" });
    });
    it("does not treat a mid-text @ as a command", () => {
        expect(parseComposerCommand("add @mentions to the composer")).toEqual({ mode: "run", body: "add @mentions to the composer" });
    });
    it("trims the goal", () => {
        expect(parseComposerCommand("  @quick   spin  ")).toEqual({ mode: "quick", body: "spin" });
    });
});

describe("runFooterFor", () => {
    it("orchestrator", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "orchestrator" })).toBe("→ adaptive lead · splits the work · set in ⚙");
    });
    it("pipeline with gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: true })).toBe("→ pipeline run · stops at a review gate · set in ⚙");
    });
    it("pipeline no gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: false })).toBe("→ pipeline run · no gate · set in ⚙");
    });
    it("undefined profile defaults to pipeline + gate", () => {
        expect(runFooterFor(undefined)).toBe("→ pipeline run · stops at a review gate · set in ⚙");
    });
});

describe("LAUNCH_COMMANDS", () => {
    it("has quick/run/ask in order", () => {
        expect(LAUNCH_COMMANDS.map((c) => c.mode)).toEqual(["quick", "run", "ask"]);
        expect(LAUNCH_COMMANDS.map((c) => c.cmd)).toEqual(["@quick", "@run", "@ask"]);
    });
});
